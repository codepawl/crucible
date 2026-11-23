import sys
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
def lum(path):
    a = np.asarray(Image.open(path).convert('RGB'), dtype=float)/255
    c = np.where(a <= 0.04045, a/12.92, ((a+0.055)/1.055)**2.4)
    return c@[0.2126,0.7152,0.0722]
def box(a, n, axis):
    k = np.ones(n)/n
    return np.apply_along_axis(lambda v: np.convolve(v, k, 'same'), axis, a)
def width_report(path, name, x0,y0,w,h):
    l = lum(path)
    hp = np.abs(l - box(box(l,3,0),3,1))
    energy = box(hp, 5, 0)[y0:y0+h, x0:x0+w]          # texture energy, smoothed 5 px down the column
    widths = []
    for column in energy.T:
        g = np.diff(column)
        i = int(np.argmax(np.abs(g)))
        lo, hi = max(0, i-20), min(len(column), i+21)
        seg = column[lo:hi]; a, b = seg.min(), seg.max()
        if b/(a+1e-6) < 2.0: continue                 # needs a real textured-to-smooth step
        t = (seg-a)/(b-a)
        if g[i] < 0: t = 1-t
        widths.append(abs(int(np.argmax(t>0.9)) - int(np.argmax(t>0.1))))
    print(f'{name}: columns {len(widths)}/{w}, median {np.median(widths):.1f} px, mean {np.mean(widths):.1f} px')
tag = sys.argv[1]
for k in ['1']:
    width_report(f'{tag}/slope-{k}.png', f'slope-{k} edge box B (x820-960,y240-360)', 820,240,140,120)
    width_report(f'{tag}/slope-{k}.png', f'slope-{k} edge box A (x480-600,y230-350)', 480,230,100,120)
