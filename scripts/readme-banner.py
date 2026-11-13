# Generates docs/images/readme-banner.svg: python3 scripts/readme-banner.py docs/images/readme-banner.svg
import sys
G = {
'O':[".###.","#...#","#...#","#...#","#...#","#...#",".###."],
'P':["####.","#...#","#...#","####.","#....","#....","#...."],
'E':["#####","#....","#....","####.","#....","#....","#####"],
'N':["#...#","##..#","#.#.#","#.#.#","#..##","#...#","#...#"],
'C':[".####","#....","#....","#....","#....","#....",".####"],
'M':["#...#","##.##","#.#.#","#.#.#","#...#","#...#","#...#"],
'U':["#...#","#...#","#...#","#...#","#...#","#...#",".###."],
'T':["#####","..#..","..#..","..#..","..#..","..#..","..#.."],
'R':["####.","#...#","#...#","####.","#.#..","#..#.","#...#"],
}
word = "OPENCOMPUTER"; S = 20; PAD = 40; BG = "#131311"
cells = []
for i, ch in enumerate(word):
    for y, row in enumerate(G[ch]):
        for x, c in enumerate(row):
            if c == "#": cells.append((i*6 + x, y))
W = PAD*2 + (len(word)*6 - 1)*S + 16; H = PAD*2 + 7*S + 16
band = lambda y: "#f2f2ee" if y < 3 else "#c9c9c3" if y < 5 else "#8f8f89"
fmt = lambda v: f"{v:g}"
path = lambda pts, s, c: f'<path fill="{c}" d="' + "".join(f"M{fmt(x)} {fmt(y)}h{fmt(s)}v{fmt(s)}h-{fmt(s)}z" for x, y in pts) + '"/>'
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
       f'<rect width="{W}" height="{H}" fill="{BG}"/>']
for off, col in ((16, "#5a5a55"), (8, "#8f8f89")):
    e = 1.5
    out.append(path([(PAD+x*S+off-e, PAD+y*S+off-e) for x, y in cells], S+2*e, col))
    out.append(path([(PAD+x*S+off, PAD+y*S+off) for x, y in cells], S, BG))
for b in ("#f2f2ee", "#c9c9c3", "#8f8f89"):
    out.append(path([(PAD+x*S, PAD+y*S) for x, y in cells if band(y) == b], S, b))
out.append('</svg>')
open(sys.argv[1], "w").write("\n".join(out))
