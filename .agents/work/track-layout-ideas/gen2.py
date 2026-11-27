css='<link rel=stylesheet href=s.css>'
X='''
.mc{border:1px solid var(--bd);border-radius:8px;max-width:720px}
.mc .mr{display:grid;grid-template-columns:16px minmax(0,auto) 1fr auto;align-items:center;column-gap:8px;padding:7px 12px}
.mc .mr+.mr,.mc .ask+.mr{border-top:1px solid var(--bd)}
.mc .mr .d,.row .d{justify-self:center}
.d.r{box-shadow:inset 0 0 0 2px var(--mf)}
.mc .t{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc .l{color:var(--mf);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc .x{font-size:12px;color:var(--faint);white-space:nowrap;display:flex;gap:10px;align-items:center}
.ask{padding:0 12px 10px 36px;display:flex;gap:8px;align-items:center}
.chip{display:inline-flex;gap:5px;align-items:center;color:var(--mf);font-size:12.5px}
.ic{width:13px;height:13px;display:inline-block;border:1.5px solid currentColor;border-radius:3px;opacity:.8}
.pill{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:15px;border:1px solid hsl(40 50% 80%);background:hsl(42 80% 96%);font-size:13px}
.g{font-size:12px;color:var(--faint);padding:18px 0 6px;display:flex;gap:6px}
.row{display:grid;grid-template-columns:16px minmax(0,max-content) 1fr auto 52px;align-items:center;column-gap:10px;height:40px;padding:0 10px;margin:0 -10px;border-radius:6px}
.row:hover,.row.h{background:var(--muted)}
.row .t{font-weight:500;white-space:nowrap}
.row .l{color:var(--mf);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .tm{font-size:12px;color:var(--faint);text-align:right}
'''
def page(n,b): open(n+'.html','w').write(f'<!doctype html><meta charset=utf-8>{css}<style>{X}</style><body>{b}</body>')
TH=[('b','Proration rules for plan changes','Charge the difference now or at renewal?','', '2m'),
    ('b','Wire the billing API to Stripe','Wants to run <span class=mono>systemctl restart billing</span>','', '6m'),
    ('r','Tax display by region','VAT and US sales tax per line','◐ Preview','12m'),
    ('r','Draft the billing page layout','Plan card, invoice table, card form','⑂ #42','20m'),
    ('w','Invoice PDF export','Rendering the template · 3 of 5 tests pass','','now'),
    ('w','Empty and error states','Writing copy for card-declined','','now'),
    ('i','Usage meter on the plan card','Waiting on CI','⑂ #47','1h')]
subs=''.join(f'<div class="it sub"><span class="d {m}"></span><span class="t">{t}</span></div>' for m,t,*_ in TH)
SB=f'''<div class="sb"><div class="org">Digger</div><div class="new">✎&nbsp; New <span class=sp></span><span class=k>N</span></div>
<div class="sec">Tracks</div><div class="it sel"><span class="d b"></span><span class="t" style="font-weight:600">Billing page</span></div>{subs}
<div class="it"><span class="d w"></span><span class="t">Onboarding emails</span></div><div class="it"><span class="d r"></span><span class="t">Docs search</span></div>
<div class="sec">Threads</div><div class="it"><span class="d i"></span><span class="t">Why is the build slow?</span></div><div class=sp></div><div class="it faint xs">igor</div></div>'''
STAND='Layout PR is up and tax preview is ready; Stripe wiring waits on a restart, proration on a decision.'
def head(tab):
  t=lambda n,l: f'<span class="{"on" if n==tab else ""}">{l}</span>'
  return f'''<div class="hd">Billing page<span class=sp></span><span class=dots>···</span></div>
<div style="padding:12px 16px 10px;border-bottom:1px solid var(--bd)" class=stand>{STAND}</div>
<div class=tabs>{t("a","Activity")}{t("t",'Threads <span style="color:var(--pend)">·</span> 7')}{t("d","Doc")}{t("r","Results · 3")}</div>'''
COMP='<div class="comp"><div class=ph>Message this track…</div><div class=tl><span>Claude Opus 5.5 ⌄</span><span>Medium ⌄</span><span style="flex:1"></span><span>⌀</span></div></div>'
def mrow(m,t,l,r,tm,ask=None):
  s=f'<div class=mr><span class="d {m}"></span><span class=t>{t}</span><span class=l>{l}</span><span class=x>{"<span class=chip>"+r+"</span>" if r else ""}</span></div>'
  if ask: s+=f'<div class=ask>{ask}</div>'
  return s
ASKQ='<span class=btn>Now, prorated</span><span class=btn>At renewal</span>'
ASKA='<span class="btn p">Allow</span><span class=btn>Don\'t allow</span>'
# ---------- F: Activity with inline minicards ----------
F=SB+f'''<div class=main>{head("a")}
<div style="flex:1;display:flex;flex-direction:column;align-items:center;overflow:hidden;padding-bottom:16px"><div style="width:720px;margin-top:auto">
<div class="msg" style="margin:0 0 18px auto;width:fit-content;background:var(--muted);padding:8px 12px;border-radius:10px">Build the billing page: plan, usage, invoices, tax</div>
<div class=msg style="margin-bottom:10px">I split it into six threads and wrote the plan into the Doc.</div>
<div class=mc style="margin-bottom:22px">{''.join(mrow(*x) for x in [TH[3],TH[2],TH[4],TH[5]])}{mrow(*TH[0],ask=ASKQ)}{mrow(*TH[1],ask=ASKA)}</div>
<div class="msg" style="margin:0 0 18px auto;width:fit-content;background:var(--muted);padding:8px 12px;border-radius:10px">Also add a usage meter to the plan card</div>
<div class=msg style="margin-bottom:10px">Started it.</div>
<div class=mc style="margin-bottom:18px">{mrow(*TH[6])}</div>
<div style="display:flex;justify-content:center;margin-bottom:10px"><span class=pill><span class="d b"></span>2 threads waiting on you<span class=mf>· Threads ↗</span></span></div>
{COMP}</div></div></div>'''
page('F',F)
# ---------- G: Threads tab ----------
def row(m,t,l,r,tm,h=False,ask=None):
  s=f'<div class="row{" h" if h else ""}"><span class="d {m}"></span><span class=t>{t}</span><span class=l>{l}</span><span class=chip>{r}</span><span class=tm>{tm}</span></div>'
  if ask: s+=f'<div style="display:flex;gap:8px;padding:0 0 10px 26px">{ask}</div>'
  return s
G=SB+f'''<div class=main>{head("t")}
<div style="flex:1;display:flex;justify-content:center;overflow:hidden"><div style="width:880px;padding-top:4px">
<div class=g><span class=pend>Waiting on you</span> 2</div>{row(*TH[0],ask=ASKQ)}{row(*TH[1],ask=ASKA)}
<div class=g>Ready to review 2</div>{row(*TH[2])}{row(*TH[3],h=True)}
<div class=g>Working 3</div>{row(*TH[4])}{row(*TH[5])}{row(*TH[6])}
<div class=g style="padding-top:22px">Done 4 <span style="margin-left:auto">Show</span></div>
</div></div></div>'''
page('G',G)
# ---------- H: anatomy close-up ----------
old='''<div style="display:flex;flex-direction:column;gap:8px;width:560px">
<div style="background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px"><div style="display:flex;gap:8px;align-items:baseline"><span style="width:9px"></span><span style="font-weight:500;font-size:15px">Usage meter on the plan card</span></div><div class="sm mf" style="margin-top:4px">Meter reads from /usage; PR open, waiting on CI.</div><div class="sm mf" style="margin-top:8px">⑂ Usage meter on the plan card</div></div>
<div style="background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px"><div style="display:flex;gap:8px;align-items:baseline"><span class="d w"></span><span style="font-weight:500;font-size:15px">Empty and error states</span></div><div class="sm mf" style="margin-top:4px">Writing copy for the no-invoices and card-declined states.</div></div>
<div style="background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px"><div style="display:flex;gap:8px;align-items:baseline"><span class="d r" style="box-shadow:inset 0 0 0 2px var(--pend)"></span><span style="font-weight:500;font-size:15px">Tax display by region</span></div><div class="sm mf" style="margin-top:4px">Tax preview ready</div><div class="sm mf" style="margin-top:8px"><span class="d r" style="box-shadow:inset 0 0 0 2px var(--pend)" style="width:8px;height:8px"></span> Tax display by region</div></div>
<div style="background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px"><div style="display:flex;gap:8px;align-items:baseline"><span class="d b"></span><span style="font-weight:500;font-size:15px">Proration rules for plan changes</span><span class="sm pend" style="margin-left:auto">blocked on you</span></div><div class="sm mf" style="margin-top:4px">Charge the difference now or at renewal?</div></div></div>'''
new=f'<div class=mc style="width:560px">{mrow(*TH[6])}{mrow(*TH[5])}{mrow(*TH[2])}{mrow(*TH[0],ask=ASKQ)}</div>'
note=lambda s: f'<div class="sm mf" style="width:560px;line-height:21px;margin-top:18px">{s}</div>'
H=f'''<div style="display:flex;gap:64px;padding:48px 64px;width:100%">
<div><div style="font-weight:600;margin-bottom:14px">Now</div>{old}{note("Four boxes; padding (12–16px) is bigger than the gap (8px), so they don't read as one list. The result repeats the title; the ready ring, the blocked dot and the amber words all compete. ~110px per thread.")}</div>
<div><div style="font-weight:600;margin-bottom:14px">Proposed</div>{new}{note("One border around the group, hairlines between rows. Title, then the latest line, muted on the same row; the result is a short chip (#47, Preview). Amber means only “needs you” (ready becomes a neutral ring), and only those rows grow: a second line with the buttons. ~36px per thread, or ~70px when it needs you.")}</div></div>'''
page('H',H)
