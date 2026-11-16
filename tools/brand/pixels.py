"""BicuSlicer pixel art: the 16x16 icon drawings (A is the one in use), the palette and a 5x7 pixel font.

Running this file directly writes concepts.svg, a side-by-side preview of the three drawings.
"""
PAL = {"K":"#16181d","G":"#8a94a6","g":"#4b5260","O":"#4dabf7","o":"#1c7ed6","Y":"#a5d8ff","W":"#eceef2","R":"#ff4d6a","B":"#5c9dff"}
A = """................
....GGGGGGGG....
....GggggggG....
....GggggggG....
....GGGGGGGG....
.....oOOOOo.....
.......OO.......
................
..YYYYYYYO......
..OOOOOOOOOOOO..
..oooooooooooo..
..OOOOOOOOOOOO..
..oooooooooooo..
..OOOOOOOOOOOO..
................
................"""
B = """................
..OOOOOOOOO.....
..OOOOOOOOOO....
..oo......ooo...
..OO.......OO...
..oo......oo....
..OOOOOOOOO.....
..ooooooooooo...
..OO.......OOO..
..oo........oo..
..OO.......OOO..
..oooooooooooo..
..OOOOOOOOOOO...
................
................
................"""
C = """.......O........
.......G........
...GGGGGGGGGG...
..GWWWWWWWWWWG..
..GWKKWWWWKKWG..
..GWKKWWWWKKWG..
..GWWWWWWWWWWG..
..GWWWOOOOWWWG..
...GGGGGGGGGG...
.....gggggg.....
...OOOOOOOOOO...
...oooooooooo...
...YYYYYYYYYY...
...OOOOOOOOOO...
...oooooooooo...
................"""
FONT = {
"B":["11110","10001","10001","11110","10001","10001","11110"],
"i":["010","000","110","010","010","010","111"],
"c":["0000","0000","0111","1000","1000","1000","0111"],
"u":["00000","00000","10001","10001","10001","10011","01101"],
"S":["01111","10000","10000","01110","00001","00001","11110"],
"l":["110","010","010","010","010","010","111"],
"e":["00000","00000","01110","10001","11111","10000","01111"],
"r":["0000","0000","1011","1100","1000","1000","1000"],
}
def rects(grid, x0, y0, s):
    out=[]
    for r,row in enumerate(grid.splitlines()):
        c=0
        while c < len(row):
            ch=row[c]
            if ch=='.': c+=1; continue
            e=c
            while e+1<len(row) and row[e+1]==ch: e+=1
            out.append(f'<rect x="{x0+c*s}" y="{y0+r*s}" width="{(e-c+1)*s}" height="{s}" fill="{PAL[ch]}"/>')
            c=e+1
    return "".join(out)
def word(text, x0, y0, s, colors):
    out=[]; x=x0
    for i,ch in enumerate(text):
        g=FONT[ch]; col=colors[i]
        for r,row in enumerate(g):
            c=0
            while c<len(row):
                if row[c]!='1': c+=1; continue
                e=c
                while e+1<len(row) and row[e+1]=='1': e+=1
                out.append(f'<rect x="{x+c*s}" y="{y0+r*s}" width="{(e-c+1)*s}" height="{s}" fill="{col}"/>'); c=e+1
        x += (len(g[0])+1)*s
    return "".join(out), x-s
import sys
if __name__=="__main__":
    parts=['<svg width="100%" viewBox="0 0 680 470" role="img" shape-rendering="crispEdges"><title>BicuSlicer pixel logo concepts</title><desc>Three 16 by 16 pixel icon concepts (nozzle over layers, layered letter B, a layered robot) and a pixel wordmark.</desc>']
    labels=["Nozzle and layers","Layered B","Bicubot robot"]
    for i,(grid,lab) in enumerate(zip([A,B,C],labels)):
        x=40+i*212
        parts.append(f'<rect x="{x}" y="20" width="176" height="176" rx="20" fill="#16181d"/>')
        parts.append(rects(grid, x+24, 44, 8))
        parts.append(f'<rect x="{x+20}" y="212" width="40" height="40" rx="6" fill="#16181d"/>'+rects(grid, x+24, 216, 2))
        parts.append(f'<rect x="{x+72}" y="220" width="24" height="24" rx="4" fill="#16181d"/>'+rects(grid, x+76, 224, 1))
        parts.append(f'<text class="ts" x="{x+104}" y="236">16 px</text>')
        parts.append(f'<text class="th" x="{x+88}" y="282" text-anchor="middle">{"ABC"[i]}. {lab}</text>')
    parts.append('<rect x="40" y="310" width="600" height="120" rx="20" fill="#16181d"/>')
    parts.append(rects(A, 64, 334, 4.5))
    w, end = word("BicuSlicer", 158, 350, 7, ["#eceef2"]*4+["#4dabf7"]*6)
    parts.append(w)
    parts.append('</svg>')
    open("concepts.svg","w").write("".join(parts))
    print(len("".join(parts)), "wordmark ends at", end)
