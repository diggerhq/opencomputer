import sys
css='<link rel=stylesheet href=s.css>'
def page(name,body,extra=''): open(name+'.html','w').write(f'<!doctype html><meta charset=utf-8>{css}<style>{extra}</style><body>{body}</body>')
OTHER='''<div class="it"><span class="d w"></span><span class="t">Onboarding emails</span><span class="n">3</span></div>
<div class="it"><span class="d r"></span><span class="t">Docs search</span><span class="n">2</span></div>
<div class="it"><span class="d i"></span><span class="t">Q4 pricing research</span><span class="n">4</span></div>'''
def sb(tracks,top=''):
  return f'''<div class="sb"><div class="org">Digger</div><div class="new">✎&nbsp; New <span class=sp></span><span class=k>N</span></div>{top}
<div class="sec">Tracks</div>{tracks}
<div class="sec">Threads</div><div class="it"><span class="d i"></span><span class="t">Why is the build slow?</span></div>
<div class="it"><span class="d r"></span><span class="t">Rotate the staging keys</span></div><div class=sp></div>
<div class="it faint xs">igor</div></div>'''
BILL_SEL='<div class="it sel"><span class="d b"></span><span class="t" style="font-weight:600">Billing page</span><span class="n">7</span></div>'
TH=[('b','Proration rules for plan changes','Asks: charge the difference now or at renewal?',''),
    ('b','Wire the billing API to Stripe','Wants to run systemctl restart billing',''),
    ('r','Tax display by region','VAT and US sales tax per line; preview is up','◐ Preview'),
    ('r','Draft the billing page layout','Plan card, invoice table and card form','⑂ PR #42'),
    ('w','Invoice PDF export','Rendering the template; 3 of 5 tests pass',''),
    ('w','Empty and error states','Writing copy for no-invoices and card-declined',''),
    ('i','Usage meter on the plan card','PR open, waiting on CI','⑂ PR #47')]
STAND='Layout PR is up and tax preview is ready; Stripe wiring waits on a restart, proration on a decision.'
COMP=lambda ph,w='': f'<div class="comp" style="{w}"><div class=ph>{ph}</div><div class=tl><span>Claude Opus 5.5 ⌄</span><span>Medium ⌄</span><span class=sp style="flex:1"></span><span>⌀</span></div></div>'

# ---------- A: sidebar is the thread list; pane = stand + waits-on-you + conversation ----------
subs=''.join(f'<div class="it sub"><span class="d {m}"></span><span class="t">{t}</span></div>' for m,t,_,_ in TH)
A=sb(BILL_SEL+subs+OTHER)+f'''<div class="main">
<div class="hd">Billing page<span class=sp></span><span class="mf sm" style="font-weight:400">Doc</span><span class="mf sm" style="font-weight:400;margin-left:14px">Results 3</span><span class=dots style="margin-left:14px">···</span></div>
<div style="flex:1;overflow:hidden;padding:28px 0 0;display:flex;flex-direction:column;align-items:center">
 <div style="width:720px">
  <div class="stand" style="font-size:16px;line-height:24px;color:var(--fg)">{STAND}</div>
  <div class="xs faint" style="margin-top:6px">Stand · updated 4 min ago · 2 working, 2 ready, 1 waiting on CI</div>
  <div style="margin-top:22px;border:1px solid hsl(40 50% 80%);background:hsl(42 80% 96%);border-radius:10px">
   <div class="xs pend" style="padding:9px 14px 0;font-weight:500">Waiting on you · 2</div>
   <div style="padding:8px 14px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid hsl(40 40% 86%)"><span class="d b"></span><div style="flex:1"><div style="font-weight:500">Proration rules for plan changes</div><div class="sm mf">Charge the difference now or at renewal?</div></div><span class="btn">Now, prorated</span><span class="btn">At renewal</span></div>
   <div style="padding:12px 14px;display:flex;align-items:center;gap:10px"><span class="d b"></span><div style="flex:1"><div style="font-weight:500">Wire the billing API to Stripe</div><div class="sm mf mono">systemctl restart billing</div></div><span class="btn p">Allow</span><span class="btn">Don't allow</span></div>
  </div>
 </div>
 <div style="width:720px;margin-top:auto;padding-bottom:16px">
  <div class=msg style="margin-bottom:14px"><div class=who>Track</div>The layout PR is ready and the tax preview is up. Two threads need you before Stripe and proration can move.</div>
  <div class="msg" style="margin:0 0 18px auto;width:fit-content;background:var(--muted);padding:8px 12px;border-radius:10px">Also add a usage meter to the plan card</div>
  <div class=msg style="margin-bottom:18px"><div class=who>Track</div>Started <u>Usage meter on the plan card</u>.</div>
  {COMP('Message this track…')}
 </div>
</div></div>'''
page('A',A)

# ---------- B: track as a page: Doc plan rows are the threads; conversation in a right column ----------
B=sb(BILL_SEL.replace('>7<','>7<')+OTHER)+f'''<div class="main">
<div class="hd">Billing page<span class=sp></span><span class=dots>···</span></div>
<div style="flex:1;display:flex;min-height:0">
 <div style="flex:1;overflow:hidden;padding:26px 40px 0 48px;border-right:1px solid var(--bd)">
  <div style="font-size:12px;color:var(--faint);margin-bottom:4px">Stand</div>
  <div style="font-size:16px;line-height:24px">{STAND}</div>
  <div style="font-size:12px;color:var(--faint);margin:26px 0 4px">Goal</div>
  <div>A billing page: plan, usage, invoices, card, tax.</div>
  <div style="font-size:12px;color:var(--faint);margin:26px 0 6px;display:flex">Plan<span class=sp style="flex:1"></span>each line is a thread</div>
  <div>''' + ''.join(f'''<div style="display:grid;grid-template-columns:18px 1fr auto;align-items:center;column-gap:10px;padding:7px 8px;margin:0 -8px;border-radius:6px;{'background:hsl(42 80% 95%)' if m=='b' else ''}"><span class="d {m}"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="font-weight:500">{t}</span><span class="sm mf"> — {l}</span></span><span class="res">{r}{' <span class=pend style=margin-left:6px>needs you</span>' if m=='b' else ''}</span></div>''' for m,t,l,r in TH) + '''
  <div style="display:grid;grid-template-columns:18px 1fr;column-gap:10px;padding:7px 0;color:var(--faint)"><span>✓</span><span>Page shell and routing · done</span></div></div>
  <div style="font-size:12px;color:var(--faint);margin:26px 0 4px">Decisions</div>
  <div class=sm>Stripe Billing, not Checkout · Prices tax-inclusive in the EU</div>
 </div>
 <div style="width:420px;flex:none;display:flex;flex-direction:column;padding:0 16px 16px">
  <div class="xs faint" style="padding:14px 0">Conversation</div>
  <div style="margin-top:auto">
   <div class=msg style="margin-bottom:14px"><div class=who>Track</div>Proration needs a call from you: charge now, or at renewal?</div>
   <div class="msg" style="margin:0 0 14px auto;width:fit-content;background:var(--muted);padding:8px 12px;border-radius:10px">Also add a usage meter</div>
   <div class=msg style="margin-bottom:16px"><div class=who>Track</div>Added it to the plan and started a thread.</div>
   '''+COMP('Message this track…')+'''</div></div>
</div></div>'''
page('B',B)

# ---------- C: inbox-first app; tracks are context ----------
top='''<div class="it sel" style="margin-top:6px"><span class="d b"></span><span class=t style="font-weight:600">Needs you</span><span class=n>3</span></div>
<div class="it"><span class="d r"></span><span class=t>Ready to review</span><span class=n>4</span></div>
<div class="it"><span class="d w"></span><span class=t>Working</span><span class=n>6</span></div>'''
C=sb('<div class="it"><span class="d b"></span><span class="t">Billing page</span><span class="n">7</span></div>'+OTHER,top)+f'''<div class="main">
<div class="hd">Needs you<span class="mf sm" style="font-weight:400">3</span><span class=sp></span><span class="xs mf" style="font-weight:400"><span class=k>J</span> <span class=k>K</span> move · <span class=k>1</span> <span class=k>2</span> answer · <span class=k>E</span> later</span></div>
<div style="flex:1;display:flex;min-height:0">
 <div style="width:380px;flex:none;border-right:1px solid var(--bd);padding:8px">
  <div class="xs faint" style="padding:8px 8px 4px">Billing page</div>
  <div class="it sel" style="height:auto;padding:8px;align-items:flex-start"><span class="d b" style="margin-top:6px"></span><div style="min-width:0"><div style="font-weight:600">Proration rules for plan changes</div><div class="sm mf" style="white-space:normal">Charge the difference now or at renewal?</div></div></div>
  <div class="it" style="height:auto;padding:8px;align-items:flex-start"><span class="d b" style="margin-top:6px"></span><div><div style="font-weight:500">Wire the billing API to Stripe</div><div class="sm mf">Approve: restart billing</div></div></div>
  <div class="xs faint" style="padding:14px 8px 4px">Docs search</div>
  <div class="it" style="height:auto;padding:8px;align-items:flex-start"><span class="d b" style="margin-top:6px"></span><div><div style="font-weight:500">Index the changelog</div><div class="sm mf">Needs an Algolia key</div></div></div>
 </div>
 <div style="flex:1;display:flex;flex-direction:column;padding:28px 48px 16px">
  <div class="xs mf">Billing page › Proration rules for plan changes</div>
  <div style="font-size:20px;line-height:28px;font-weight:600;margin:10px 0 14px">Charge the difference now or at renewal?</div>
  <div style="max-width:620px;line-height:22px">Stripe supports both. Charging now (prorated) matches what customers expect when they upgrade mid-cycle; at renewal is simpler and avoids a surprise invoice. Downgrades credit the next invoice either way.</div>
  <div style="display:flex;gap:10px;margin-top:20px"><span class="btn" style="height:34px;padding:0 14px"><span class=k style="margin-right:8px">1</span>Now, prorated</span><span class="btn" style="height:34px;padding:0 14px"><span class=k style="margin-right:8px">2</span>At renewal</span></div>
  <div style="margin-top:auto;border-top:1px solid var(--bd);padding-top:14px;max-width:720px">
   <div class="xs faint" style="margin-bottom:6px">Track context</div>
   <div class="sm mf" style="margin-bottom:10px">{STAND}</div>
   <div class=sm style="display:flex;gap:14px;flex-wrap:wrap;color:var(--mf)"><span><span class="d b"></span> 2 need you</span><span><span class="d r"></span> 2 ready</span><span><span class="d w"></span> 2 working</span><span><span class="d i" style="border:1px solid var(--in)"></span> 1 idle</span><u style="margin-left:auto">Open track</u></div>
   <div style="margin-top:14px">{COMP('Reply in this thread…')}</div>
  </div>
 </div>
</div></div>'''
page('C',C)

# ---------- D: one conversation at a time; threads are tabs under the track ----------
tabs='<span class="tab on">Track</span>'+''.join(f'<span class="tab"><span class="d {m}"></span>{s}</span>' for m,s in [('b','Proration'),('b','Stripe'),('r','Tax display'),('r','Layout'),('w','Invoice PDF'),('w','Empty states')])+'<span class="tab mf">+1</span>'
D=sb('<div class="it sel"><span class="d b"></span><span class="t" style="font-weight:600">Billing page</span><span class="n">7</span></div>'+OTHER)+f'''<div class="main">
<div class="hd">Billing page<span class="stand" style="font-weight:400;overflow:hidden;text-overflow:ellipsis;margin-left:6px">— {STAND}</span><span class=sp></span><span class="mf sm" style="font-weight:400">Doc</span><span class="mf sm" style="font-weight:400;margin-left:14px">Results 3</span><span class=dots style="margin-left:14px">···</span></div>
<div class="tstrip">{tabs}</div>
<div style="flex:1;display:flex;flex-direction:column;align-items:center;padding:0 0 16px">
 <div style="width:720px;margin-top:auto">
  <div class=msg style="margin-bottom:16px"><div class=who>Track</div>Started seven threads from the plan. The layout PR is ready, and the tax preview is up.</div>
  <div class=msg style="margin-bottom:16px;border:1px solid hsl(40 50% 80%);background:hsl(42 80% 96%);border-radius:10px;padding:10px 14px"><div class="xs pend" style="font-weight:500">Proration · asks you</div>Charge the difference now or at renewal?<div style="display:flex;gap:8px;margin-top:8px"><span class=btn>Now, prorated</span><span class=btn>At renewal</span><span class="sm mf" style="align-self:center;margin-left:6px">open thread ⏎</span></div></div>
  <div class=msg style="margin-bottom:18px;border:1px solid hsl(40 50% 80%);background:hsl(42 80% 96%);border-radius:10px;padding:10px 14px"><div class="xs pend" style="font-weight:500">Stripe · asks to run</div><span class=mono>systemctl restart billing</span><div style="display:flex;gap:8px;margin-top:8px"><span class="btn p">Allow</span><span class=btn>Don't allow</span></div></div>
  {COMP('Message this track…  <span class="k">⌘1–8</span> switch tab')}
 </div>
</div></div>'''
page('D',D,'.tstrip{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--bd);flex:none}.tab{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:7px;font-size:13px;white-space:nowrap;color:var(--fg)}.tab.on{background:var(--sel);font-weight:500}')

# ---------- E: minimal: rows not cards, grouped by what they need ----------
grp=[('Needs you',[0,1]),('Ready',[2,3]),('Working',[4,5,6])]
rows=''
for g,ix in grp:
  rows+=f'<div class="xs faint" style="padding:10px 0 2px">{g}</div>'
  for i in ix:
    m,t,l,r=TH[i]
    act='<span class=btn>Now, prorated</span><span class=btn>At renewal</span>' if i==0 else ('<span class="btn p">Allow</span><span class=btn>Deny</span>' if i==1 else f'<span class=res>{r}</span>')
    rows+=f'<div style="display:flex;align-items:center;gap:10px;height:34px;padding:0 8px;margin:0 -8px;border-radius:6px"><span class="d {m}"></span><span style="font-weight:500;white-space:nowrap">{t}</span><span class="sm mf" style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{l}</span>{act}</div>'
E=sb(BILL_SEL+OTHER)+f'''<div class="main">
<div class="hd">Billing page<span class=sp></span><span class=dots>···</span></div>
<div style="padding:12px 16px 10px;border-bottom:1px solid var(--bd)" class=stand>{STAND}</div>
<div class=tabs><span class=on>Activity</span><span>Doc</span><span>Results · 3</span></div>
<div style="padding:4px 0 10px;border-bottom:1px solid var(--bd);display:flex;justify-content:center"><div style="width:880px">{rows}</div></div>
<div style="flex:1;display:flex;flex-direction:column;align-items:center;padding-bottom:16px"><div style="width:720px;margin-top:auto">
<div class=msg style="margin-bottom:16px"><div class=who>Track</div>Started <u>Usage meter on the plan card</u>.</div>
{COMP('Message this track…')}</div></div></div>'''
page('E',E)
