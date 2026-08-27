package awsvmlite

// Voucher publication: how a box gets to the edge without the edge asking.
//
// The measured problem this exists to solve: at burst-100 a create spent 310ms
// in the edge→control-plane call while the CP's own handler took 75
// MICROSECONDS and absorbed the whole burst inside 30ms. The time is not work.
// It is a Cloudflare Worker isolate waiting to be scheduled — an invocation may
// hold only six open connections, and every subrequest and waitUntil takes one.
// So the fix is not to make the call faster. It is to not make the call.
//
// A voucher is a box, pre-paired with a sandbox ID and pre-authenticated,
// published to the edge BEFORE any customer asks. The edge caches a book of
// them per colo and answers a create out of that book with zero subrequests.
//
// The voucher confers nothing. It is a hint that a box is probably free. Two
// colos, two isolates, or a stale cache can all name the same box; ownership is
// settled at the box by an idempotent compare-and-swap (see
// cmd/microvm-hooks/claim.go). That is what lets this side be sloppy and fast.
//
// Three states, and a box is in exactly one:
//
//	warm       nobody has been promised it
//	vouchered  promised to a colo, not yet redeemed — still ours to take back
//	bound      a customer owns it
//
// vouchered is NOT bound. A vouchered box may expire back to warm; a bound one
// never does. Conflating the two is how the previous attempt stranded stock.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

// voucherReserve is how many warm boxes are never vouchered.
//
// The control-plane create path still exists — an org without the flag, a
// non-default shape, an edge that missed its book — and it claims from `warm`.
// Vouchering the last box would make that path fail while the fleet sat idle
// holding promises nobody had redeemed yet. Small, because the lite lane sends
// essentially everything through vouchers.
const voucherReserve = 4

// coloFraction is the share of stock one colo's book may hold.
//
// The default stays at 0.8 because the ceiling is real when traffic arrives in
// several colos — see the two failures documented at the cap below. It is a knob
// because it is NOT real when one colo serves everything: at a 150-box pool the
// default caps the book at 120, and a burst of 100 into 120 slots is a load
// factor of 0.83, where the free-list draw has to walk further to find an
// unclaimed box. A single-colo dev cell can safely run this near 1.
func coloFraction() float64 {
	if v := os.Getenv("OPENSANDBOX_MICROVM_VOUCHER_COLO_FRACTION"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 && f <= 1 {
			return f
		}
	}
	return 0.8
}

// voucherTTL bounds how long a promise ties up a box.
//
// LONG on purpose, and it is ReconcileVouchers that makes long safe: expiry no
// longer re-pools on an assumption, it asks the box who owns it. So the cost of
// a generous TTL is idle stock, not a correctness risk — and the colo cap bounds
// how much stock any one colo can hold idle.
//
// Short was actively harmful. At 180s against a 45s book, a burst arriving after
// any idle gap found the book aged out, so all 100 creates missed, fell through
// to the control plane at once, and drove it to 5.1s of D1 and 35 rate-limit
// 503s — measured 2026-08-26, TTI p50 8.7s, i.e. WORSE than having no voucher
// path at all. A cold book must never be the common case.
//
// Must still comfortably exceed the edge's book TTL (30 min), so a voucher
// cannot expire while it is still being handed out. Well inside the 8h box
// service cap, so a promise never outlives the box it names.
const voucherTTL = 60 * time.Minute

// Voucher is what the edge caches: everything needed to reach a box, and
// nothing else.
//
// Deliberately NO sandbox ID. Pre-pairing one here is what made burst unsafe —
// a book of N serving a burst of B>N means, by pigeonhole, that several creates
// draw the same voucher, and a sandbox id inside it turns that into two
// customers holding the SAME sandbox. The guest CAS cannot catch that: it sees
// one id claiming its box twice and correctly calls it an idempotent replay.
//
// The edge mints the sandbox id per create instead, so a duplicate draw is two
// different sandboxes racing for one box — the case the CAS exists to settle.
// A voucher is therefore a hint about a BOX, and the box is its only identity.
type Voucher struct {
	MicrovmID string `json:"microvmID"`
	Endpoint  string `json:"endpoint"`
	Token     string `json:"token"`
	Port      int32  `json:"port"`
	// ExpiresAtUnix lets the edge skip a voucher that is about to be reaped
	// rather than hand out one that will lose its race.
	ExpiresAtUnix int64 `json:"expiresAtUnix"`
}

type voucherEntry struct {
	box  *Box
	colo string
	exp  time.Time
}

// Vouchers promises up to n warm boxes to one colo.
//
// Each colo gets a DISJOINT set: a box leaves `warm` the moment it is promised,
// so no two colos can be handed the same one. That removes the largest source of
// avoidable claim conflicts, leaving only the ones the CAS is actually there for
// (two isolates in the SAME colo drawing the same index from a shared book).
//
// Returning fewer than n is normal and not an error — the edge tops its book up
// again on its next off-path refresh, and a create that finds the book empty
// falls back to the control plane, which is the path this whole mechanism exists
// to skip but which remains correct.
func (m *Manager) Vouchers(colo string, n int) []Voucher {
	if m == nil || n <= 0 {
		return nil
	}
	now := time.Now()
	exp := now.Add(voucherTTL)

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.vouchered == nil {
		m.vouchered = map[string]*voucherEntry{}
	}

	// Never promise the reserve away — see voucherReserve.
	avail := len(m.warm) - voucherReserve
	if avail <= 0 {
		return nil
	}
	if n > avail {
		n = avail
	}
	// Bound what ONE colo may hold, without making its book useless.
	//
	// Two failures shaped this number, in opposite directions:
	//
	//   Unbounded — a few probe creates from a laptop pulled 96 of 100 boxes
	//   into an SJC book nobody would ever draw from, and the real client in
	//   IAD found nothing for a full voucher TTL.
	//
	//   Half — a burst of 100 against a book of 50 could only ever serve half
	//   its creates from vouchers, and the constant refilling that caused
	//   rotated the book out from under its own in-flight execs.
	//
	// So: generous enough that a colo's book can cover a burst the size of the
	// pool, but never the whole supply. Unused promises come back on their own —
	// ReconcileVouchers asks each box and re-pools the genuinely idle ones — so
	// the cost of being generous is bounded and self-healing, whereas the cost
	// of being stingy is a book that cannot do its job.
	if cap := int(float64(len(m.warm)+len(m.vouchered)) * coloFraction()); n > cap && cap > 0 {
		n = cap
	}

	out := make([]Voucher, 0, n)
	for i := 0; i < n; i++ {
		last := len(m.warm) - 1
		b := m.warm[last]
		m.warm = m.warm[:last]

		// Keyed by BOX. A promise is about a box; which sandbox redeems it is
		// not knowable here, and pretending otherwise was the defect.
		m.vouchered[b.MicrovmID] = &voucherEntry{box: b, colo: colo, exp: exp}
		out = append(out, Voucher{
			MicrovmID:     b.MicrovmID,
			Endpoint:      b.Endpoint,
			Token:         b.Token,
			Port:          m.agentPort(),
			ExpiresAtUnix: exp.Unix(),
		})
	}
	log.Printf("awsvmlite: vouchered %d box(es) to colo %s (asked %d, warm=%d vouchered=%d)",
		len(out), colo, n, len(m.warm), len(m.vouchered))
	return out
}

// RedeemVoucher converts a promise into ownership, and is the ONLY way a
// vouchered box becomes bound.
//
// Takes the BOX and the sandbox that won it. The edge minted that sandbox id, so
// this is the first time the cell sees it — which is why the pairing has to
// arrive from outside rather than be looked up.
//
// Idempotent, mirroring the guest CAS: redeeming an already-redeemed sandbox
// returns its box again rather than failing, because the edge retries and a
// finalize can arrive twice.
func (m *Manager) RedeemVoucher(microvmID, sandboxID string, meta Meta) (*Box, bool, bool) {
	if m == nil || microvmID == "" || sandboxID == "" {
		return nil, false, false
	}
	meta = m.delivered(meta)

	m.mu.Lock()
	defer m.mu.Unlock()
	if b, ok := m.bound[sandboxID]; ok {
		if b.MicrovmID == microvmID {
			// Already redeemed against this box. Refresh the meta — the first
			// redeem may have run before the real config was known — and report
			// success.
			b.Meta = meta
			return b, true, false
		}
		// A REBIND. The edge could not use the box the create announced (it was
		// dead, or already owned) and moved this sandbox to another one, then
		// re-sent the finalize naming the box that actually took the claim.
		//
		// This has to be honoured, not treated as a duplicate: whatever we have
		// recorded here is what a destroy will terminate, so leaving the old box
		// in place would eventually kill a box belonging to someone else.
		e, ok := m.vouchered[microvmID]
		if !ok {
			// The edge claimed a box we no longer have promised. Keep the old
			// record rather than inventing one; reconciliation will ask the
			// boxes themselves who owns what.
			log.Printf("awsvmlite: rebind for %s named unvouchered box %s — keeping %s", sandboxID, microvmID, b.MicrovmID)
			return b, false, false
		}
		delete(m.vouchered, microvmID)
		e.box.Meta = meta
		e.box.boundAt = time.Now()
		m.bound[sandboxID] = e.box
		// The old box is deliberately NOT re-pooled. It is either gone or live
		// under a different sandbox, and the edge is in no position to assert
		// which — see ReconcileVouchers, which asks each box directly.
		log.Printf("awsvmlite: rebound %s from box %s to %s", sandboxID, b.MicrovmID, microvmID)
		return e.box, true, true
	}
	e, ok := m.vouchered[microvmID]
	if !ok {
		return nil, false, false
	}
	delete(m.vouchered, microvmID)
	e.box.Meta = meta
	e.box.boundAt = time.Now()
	m.bound[sandboxID] = e.box
	return e.box, true, false
}

// ReconcileVouchers settles promises that ran out of time.
//
// THE TRAP THIS EXISTS FOR. "Unredeemed" does NOT mean "unclaimed". The edge
// serves a book that several isolates read at once, so two creates can draw box
// B and arrive at it as S1 and S2. The box's CAS picks one; the loser retries
// elsewhere. Meanwhile B's promise here may sit unredeemed — while B is being
// used by a paying customer. Re-pooling it on that basis would hand a live
// sandbox to the next person who asked, which is the single worst thing this
// system could do.
//
// The same duplicate draw can also leave this cell's bookkeeping naming the
// wrong box: both creates enqueue a finalize for B before either has raced, so
// the first finalize binds B to whichever sandbox it belongs to, which may not
// be the one the box chose. Ownership is still decided exactly once, at the box,
// so no customer ever reaches another's sandbox — but the cell's view can lag,
// and the adopt case below is what converges it back to what the box says.
//
// So an expired voucher is not evidence of anything. We ask the BOX, which is
// the only authority on who owns it (/healthz reports claimedBy, written by the
// same CAS that decided it), and then:
//
//	unclaimed        → genuinely nobody's; return it to the warm set
//	claimed by S'    → adopt the binding we did not know about
//	cannot tell      → leave it promised and retry on the next tick
//
// The last case is why this is idempotent and safe to call on a timer: a box we
// could not reach keeps its promise rather than being guessed about.
func (m *Manager) ReconcileVouchers(ctx context.Context) {
	if m == nil {
		return
	}
	now := time.Now()
	type pending struct {
		id string
		e  *voucherEntry
	}
	var expired []pending

	m.mu.Lock()
	for id, e := range m.vouchered {
		if now.Before(e.exp) {
			continue
		}
		delete(m.vouchered, id)
		expired = append(expired, pending{id, e})
	}
	m.mu.Unlock()
	if len(expired) == 0 {
		return
	}

	repooled, adopted, unknown := 0, 0, 0
	for _, x := range expired {
		owner, ok := m.boxClaimedBy(ctx, x.e.box)
		switch {
		case !ok:
			// Could not ask. Re-promise with a short extension so the next tick
			// tries again rather than resolving this on a guess.
			m.mu.Lock()
			x.e.exp = now.Add(30 * time.Second)
			m.vouchered[x.id] = x.e
			m.mu.Unlock()
			unknown++
		case owner == "":
			m.mu.Lock()
			m.warm = append(m.warm, x.e.box)
			m.mu.Unlock()
			repooled++
		default:
			// Claimed under a sandbox id we never redeemed — the edge drew this
			// box from the book twice, or its finalize was lost. The box says
			// who owns it; believe the box.
			m.mu.Lock()
			x.e.box.Meta = m.delivered(x.e.box.Meta)
			x.e.box.boundAt = now
			m.bound[owner] = x.e.box
			m.mu.Unlock()
			adopted++
		}
	}
	log.Printf("awsvmlite: voucher reconcile — %d re-pooled, %d adopted, %d unresolved (warm=%d vouchered=%d)",
		repooled, adopted, unknown, m.warmCount(), m.VoucherStock())
}

// boxClaimedBy asks a box who owns it. ok=false means we could not find out,
// which is deliberately distinct from "nobody" — see ReconcileVouchers.
func (m *Manager) boxClaimedBy(ctx context.Context, b *Box) (owner string, ok bool) {
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := m.do(reqCtx, b, http.MethodGet, "/healthz", nil)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	var h struct {
		Claimed   bool   `json:"claimed"`
		ClaimedBy string `json:"claimedBy"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&h); err != nil {
		return "", false
	}
	if !h.Claimed {
		return "", true
	}
	return h.ClaimedBy, true
}

func (m *Manager) warmCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.warm)
}

// VoucherStock reports promises outstanding, for the filler and for telemetry.
func (m *Manager) VoucherStock() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.vouchered)
}

// vvoucherBoxesLocked lists vouchered boxes so the keepalive can touch them.
// Caller holds m.mu.
//
// Vouchered boxes are live boxes sitting idle, so they need the touch exactly as
// warm ones do. Missing them was the shape of an earlier outage: stock that AWS
// suspended underneath us because nothing was keeping its idle timer fed.
func (m *Manager) voucherBoxesLocked() []*Box {
	out := make([]*Box, 0, len(m.vouchered))
	for _, e := range m.vouchered {
		out = append(out, e.box)
	}
	return out
}

// agentPort is nil-safe on the client, matching delivered(): voucher minting is
// reached from tests that never talk to AWS, and a missing client should degrade
// rather than panic.
func (m *Manager) agentPort() int32 {
	if m == nil || m.client == nil {
		return 0
	}
	return m.client.Config().AgentPort
}

// logState prints the warm/vouchered/bound split on every touch tick.
//
// Rate-limited to once a minute: the tick is every few seconds, and the useful
// signal is a trend, not a stream. Logged even when nothing changed — a stuck
// count IS the symptom worth seeing.
func (m *Manager) logState() {
	m.mu.Lock()
	warm, vouch, bound := len(m.warm), len(m.vouchered), len(m.bound)
	last := m.lastStateLog
	now := time.Now()
	if now.Sub(last) < time.Minute {
		m.mu.Unlock()
		return
	}
	m.lastStateLog = now
	// Oldest outstanding promise, so a pool pinned by a long voucher TTL is
	// visible as such rather than as unexplained missing stock.
	oldest := time.Duration(0)
	for _, e := range m.vouchered {
		if age := now.Sub(e.exp.Add(-voucherTTL)); age > oldest {
			oldest = age
		}
	}
	m.mu.Unlock()
	log.Printf("awsvmlite: state warm=%d vouchered=%d bound=%d depth=%d/%d oldest-voucher=%s",
		warm, vouch, bound, warm+vouch, m.cfg.WarmTarget, oldest.Round(time.Second))
}

// ColoVouchers is Vouchers for a holder that keeps its stock in RAM.
//
// The difference is re-listing. Vouchers only ever hands out boxes from `warm`,
// which is right for a colo book that persists in Cloudflare's cache: a box
// already promised to that colo is already in its book, and re-issuing it would
// duplicate the entry.
//
// The in-region cache is not like that. It holds stock in memory, so a restart
// or an 8h rotation loses every promise it was holding while this side still
// believes those boxes are spoken for. With only Vouchers, the replacement
// instance would come up nearly empty and stay that way until each promise aged
// out — minutes of creates falling through to the slow path, on exactly the
// event (rotation) the design exists to make invisible.
//
// So this returns everything currently promised to `colo`, with a refreshed
// expiry, and tops up from warm to n. Re-listing is safe because the holder is
// the same one that already had them: it cannot double-issue a box the cache is
// simultaneously handing out, since the cache dedups by box id and this side
// hands the whole set to one holder.
//
// Redeemed boxes cannot appear here: RedeemVoucher removes the entry when it
// binds, so `vouchered` is by construction the un-redeemed set.
func (m *Manager) ColoVouchers(colo string, n int) []Voucher {
	if m == nil || n <= 0 {
		return nil
	}
	now := time.Now()
	exp := now.Add(voucherTTL)

	m.mu.Lock()
	if m.vouchered == nil {
		m.vouchered = map[string]*voucherEntry{}
	}
	out := make([]Voucher, 0, n)
	for _, e := range m.vouchered {
		if e.colo != colo || e.box == nil {
			continue
		}
		e.exp = exp
		out = append(out, Voucher{
			MicrovmID:     e.box.MicrovmID,
			Endpoint:      e.box.Endpoint,
			Token:         e.box.Token,
			Port:          m.agentPort(),
			ExpiresAtUnix: exp.Unix(),
		})
		if len(out) >= n {
			break
		}
	}
	m.mu.Unlock()

	if len(out) >= n {
		return out
	}
	// Top up through the normal path so the reserve and the per-colo cap are
	// enforced in exactly one place.
	return append(out, m.Vouchers(colo, n-len(out))...)
}
