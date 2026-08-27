package awsvmlite

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func mgrWithWarm(n int) *Manager {
	m := &Manager{bound: map[string]*Box{}}
	for i := 0; i < n; i++ {
		m.warm = append(m.warm, &Box{MicrovmID: "mvm-" + itoa(i), Endpoint: "e", Token: "t"})
	}
	return m
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// Two colos must never be handed the same box. This is the property that keeps
// CAS conflicts down to the same-colo case the CAS actually exists for.
func TestVouchersAreDisjointAcrossColos(t *testing.T) {
	m := mgrWithWarm(30)
	a := m.Vouchers("IAD", 10)
	b := m.Vouchers("SJC", 10)
	if len(a) != 10 || len(b) != 10 {
		t.Fatalf("got %d and %d vouchers, want 10 each", len(a), len(b))
	}
	seen := map[string]string{}
	for _, v := range a {
		seen[v.MicrovmID] = "IAD"
	}
	for _, v := range b {
		if other, dup := seen[v.MicrovmID]; dup {
			t.Fatalf("box %s vouchered to both %s and SJC", v.MicrovmID, other)
		}
	}
}

// The reserve is what keeps the control-plane fallback path alive while the
// edge holds promises on everything else.
// One colo must not be able to drain the supply — traffic arrives in several,
// and a book only helps the colo holding it.
func TestOneColoCannotTakeEverything(t *testing.T) {
	m := mgrWithWarm(100)
	first := m.Vouchers("SJC", 1000)
	if len(first) > 80 {
		t.Fatalf("one colo took %d of 100, want <= 80", len(first))
	}
	// ...and still large enough to cover a pool-sized burst, which half was not.
	if len(first) < 64 {
		t.Fatalf("one colo got only %d of 100 — too thin to serve a burst", len(first))
	}
	if got := m.Vouchers("IAD", 1000); len(got) == 0 {
		t.Fatal("second colo was starved by the first")
	}
}

func TestVouchersKeepAReserve(t *testing.T) {
	m := mgrWithWarm(voucherReserve + 3)
	got := m.Vouchers("IAD", 100)
	// Bounded by BOTH the reserve (avail = 3) and the half-of-stock colo cap.
	if len(got) == 0 || len(got) > 3 {
		t.Fatalf("vouchered %d, want 1..3 (reserve %d held back)", len(got), voucherReserve)
	}
	if m.Depth() != voucherReserve+3 {
		t.Fatalf("Depth = %d, want %d — vouchered stock must still count", m.Depth(), voucherReserve+3)
	}
	// At or below the reserve, nothing is promised.
	m2 := mgrWithWarm(voucherReserve)
	if got := m2.Vouchers("IAD", 10); len(got) != 0 {
		t.Fatalf("vouchered %d from a reserve-only pool, want 0", len(got))
	}
}

func TestRedeemBindsAndIsIdempotent(t *testing.T) {
	m := mgrWithWarm(10)
	v := m.Vouchers("IAD", 1)[0]

	box, ok, _ := m.RedeemVoucher(v.MicrovmID, "sb-cust1", Meta{Template: "t1"})
	if !ok || box == nil {
		t.Fatal("first redeem failed")
	}
	if m.VoucherStock() != 0 {
		t.Fatalf("voucher still outstanding after redeem")
	}
	// Redeem again — finalize can arrive twice.
	box2, ok, _ := m.RedeemVoucher(v.MicrovmID, "sb-cust1", Meta{Template: "t2"})
	if !ok || box2 != box {
		t.Fatal("redeem is not idempotent")
	}
	// An unknown box must not invent a binding.
	if _, ok, _ := m.RedeemVoucher("mvm-nope", "sb-nope", Meta{}); ok {
		t.Fatal("redeemed a voucher that was never issued")
	}
}

// Expiry alone must NOT re-pool: an unredeemed voucher is not evidence the box
// is free. ReconcileVouchers asks the box, and with no box reachable here it
// must leave the promise in place rather than guess.
func TestExpiredVoucherIsNotRepooledWithoutAsking(t *testing.T) {
	m := mgrWithWarm(10)
	m.http = &http.Client{Timeout: time.Millisecond}
	vs := m.Vouchers("IAD", 3)
	warmBefore := len(m.warm)

	m.mu.Lock()
	for _, e := range m.vouchered {
		e.exp = time.Now().Add(-time.Second)
	}
	m.mu.Unlock()

	m.ReconcileVouchers(context.Background())

	if len(m.warm) != warmBefore {
		t.Fatalf("warm = %d, want %d — an unverified box must never be re-pooled", len(m.warm), warmBefore)
	}
	if m.VoucherStock() != len(vs) {
		t.Fatalf("vouchered = %d, want %d — unresolved promises must be retried, not dropped",
			m.VoucherStock(), len(vs))
	}
}

// A redeemed voucher is a customer's box and is never touched by reconciliation.
func TestReconcileLeavesRedeemedAlone(t *testing.T) {
	m := mgrWithWarm(10)
	m.http = &http.Client{Timeout: time.Millisecond}
	vs := m.Vouchers("IAD", 2)
	if _, ok, _ := m.RedeemVoucher(vs[0].MicrovmID, "sb-kept", Meta{}); !ok {
		t.Fatal("redeem failed")
	}
	m.mu.Lock()
	for _, e := range m.vouchered {
		e.exp = time.Now().Add(-time.Second)
	}
	m.mu.Unlock()

	m.ReconcileVouchers(context.Background())

	if _, ok := m.bound["sb-kept"]; !ok {
		t.Fatal("reconciliation disturbed a redeemed binding")
	}
}

// A voucher must not carry a sandbox identity, and two creates drawing the same
// box must be able to arrive as DIFFERENT sandboxes.
//
// This is the defect that made burst unusable. The book is finite, so a burst
// larger than it forces duplicate draws by pigeonhole; when the sandbox id came
// from the voucher, a duplicate draw meant two customers holding the same
// sandbox, and nothing downstream could tell — the guest CAS saw one id claiming
// its box twice and correctly reported an idempotent replay. With the id minted
// per create, the same duplicate is two sandboxes racing for one box, which the
// CAS settles.
func TestVoucherCarriesNoSandboxIdentity(t *testing.T) {
	m := mgrWithWarm(10)
	v := m.Vouchers("IAD", 1)[0]

	// The same box, redeemed by the sandbox that actually won it.
	if _, ok, _ := m.RedeemVoucher(v.MicrovmID, "sb-winner", Meta{}); !ok {
		t.Fatal("redeem by box failed")
	}
	if _, ok := m.bound["sb-winner"]; !ok {
		t.Fatal("binding was not recorded under the edge-minted sandbox id")
	}
	// A second create that drew the same voucher finalizes too. It must not
	// invent a second binding for a box already spoken for.
	if _, ok, _ := m.RedeemVoucher(v.MicrovmID, "sb-loser", Meta{}); ok {
		t.Fatal("a spent voucher was redeemed twice under different sandboxes")
	}
	if _, ok := m.bound["sb-loser"]; ok {
		t.Fatal("loser got a binding to a box it does not own")
	}
}

// A rebind is the exec ladder telling the cell it could not use the box the
// create announced. It has to MOVE the binding: whatever is recorded here is
// what a destroy terminates, so keeping the first box would eventually kill one
// belonging to someone else.
func TestRebindMovesTheBindingToTheBoxThatWon(t *testing.T) {
	m := mgrWithWarm(10)
	vs := m.Vouchers("IAD", 2)
	if len(vs) < 2 {
		t.Fatalf("want 2 vouchers, got %d", len(vs))
	}

	if _, ok, rebound := m.RedeemVoucher(vs[0].MicrovmID, "sb-x", Meta{}); !ok || rebound {
		t.Fatalf("first redeem: ok=%v rebound=%v, want true/false", ok, rebound)
	}

	box, ok, rebound := m.RedeemVoucher(vs[1].MicrovmID, "sb-x", Meta{})
	if !ok || !rebound {
		t.Fatalf("rebind: ok=%v rebound=%v, want true/true", ok, rebound)
	}
	if box.MicrovmID != vs[1].MicrovmID {
		t.Fatalf("bound to %s, want the box that won (%s)", box.MicrovmID, vs[1].MicrovmID)
	}

	// The abandoned box is NOT re-pooled. It is either gone or live under
	// another sandbox, and only the box itself can say which.
	if got, ok := m.BoxFor("sb-x"); !ok || got.MicrovmID != vs[1].MicrovmID {
		t.Fatalf("BoxFor: %v %v, want %s", got, ok, vs[1].MicrovmID)
	}
}

// The rotation-survival property. A cache instance holds its stock in RAM, so
// an 8h rotation or a restart loses every promise while this side still thinks
// those boxes are spoken for. If the replacement could only draw from `warm` it
// would come up nearly empty and stay that way until each promise aged out —
// minutes of creates falling through on precisely the event rotation is meant
// to hide.
func TestColoVouchersRelistsSoAReplacementComesUpFull(t *testing.T) {
	m := mgrWithWarm(100)
	first := m.ColoVouchers("cache", 60)
	if len(first) == 0 {
		t.Fatal("no vouchers issued")
	}
	warmAfter := len(m.warm)

	// The instance holding these dies; a fresh one asks for the same set.
	second := m.ColoVouchers("cache", 60)
	if len(second) != len(first) {
		t.Fatalf("replacement got %d, want the same %d — it must come up full", len(second), len(first))
	}
	if len(m.warm) != warmAfter {
		t.Fatalf("warm = %d, want %d — re-listing must not consume more stock", len(m.warm), warmAfter)
	}
	ids := map[string]bool{}
	for _, v := range first {
		ids[v.MicrovmID] = true
	}
	for _, v := range second {
		if !ids[v.MicrovmID] {
			t.Fatalf("box %s appeared only on the re-list", v.MicrovmID)
		}
	}
}

// Re-listing must refresh expiry, or a long-lived cache would be handed
// vouchers that its own expiry guard immediately discards.
func TestColoVouchersRefreshesExpiry(t *testing.T) {
	m := mgrWithWarm(20)
	first := m.ColoVouchers("cache", 5)
	if len(first) == 0 {
		t.Fatal("no vouchers")
	}
	m.mu.Lock()
	for _, e := range m.vouchered {
		e.exp = time.Now().Add(30 * time.Second)
	}
	m.mu.Unlock()

	second := m.ColoVouchers("cache", 5)
	for _, v := range second {
		if time.Until(time.Unix(v.ExpiresAtUnix, 0)) < time.Minute {
			t.Fatalf("box %s re-listed with a stale expiry", v.MicrovmID)
		}
	}
}

// A second holder must not be handed boxes already promised to the cache.
func TestColoVouchersDoesNotLeakAcrossHolders(t *testing.T) {
	m := mgrWithWarm(100)
	mine := m.ColoVouchers("cache", 40)
	other := m.ColoVouchers("SJC", 40)
	seen := map[string]bool{}
	for _, v := range mine {
		seen[v.MicrovmID] = true
	}
	for _, v := range other {
		if seen[v.MicrovmID] {
			t.Fatalf("box %s promised to both holders", v.MicrovmID)
		}
	}
}
