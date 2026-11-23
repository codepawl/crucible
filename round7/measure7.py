import sys, math
import numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
def load(n): return np.asarray(Image.open(n).convert('RGB'), dtype=float)
def lin(a):
    a = a/255.0
    return np.where(a <= 0.04045, a/12.92, ((a+0.055)/1.055)**2.4)
def lab(rgb):
    c = lin(rgb)
    x = c@[0.4124,0.3576,0.1805]/0.95047; y = c@[0.2126,0.7152,0.0722]; z = c@[0.0193,0.1192,0.9505]/1.08883
    f = lambda t: np.where(t>0.008856, np.cbrt(t), 7.787*t+16/116)
    fx,fy,fz = f(x),f(y),f(z)
    return 116*fy-16, 500*(fx-fy), 200*(fy-fz)
def lum(img): return lin(img)@[0.2126,0.7152,0.0722]
def stats(pix):
    L,a,b = lab(pix)
    return dict(L=float(L.mean()), chroma=float(np.hypot(a,b).mean()), hue=math.degrees(math.atan2(b.mean(),a.mean())), lum=float(lum(pix).mean()), lumstd=float(lum(pix).std()))
def row(name, s): print(f"{name:14s} L {s['L']:.1f}  chroma {s['chroma']:.1f}  hue {s['hue']:.0f}  mean lum {s['lum']:.4f}  lum std {s['lumstd']:.4f}")
photo = load('photo/rainy-road.jpg')
print('photo size', photo.shape)
box = photo[640:760, 640:840].reshape(-1,3)   # y 640-760, x 640-840, between the yellow and the right white line
row('CC0 photo', stats(box))
dry = load('road-0.png')
road = np.zeros(dry.shape[:2], bool); road[400:540, 100:900] = True
road &= dry.max(axis=2) < 200
for k in ['0','0.5','1']:
    im = load(f'road-{k}.png') if len(sys.argv)<2 else load(f'{sys.argv[1]}/road-{k}.png')
    row('road '+k, stats(im[road]))

# exposure-independent: road mean luma over sky mean luma
sky_photo = photo[40:240, 620:780].reshape(-1,3)
print('photo road/sky lum ratio', round(float(lum(box).mean()/lum(sky_photo).mean()),3), 'sky lum', round(float(lum(sky_photo).mean()),3))
tag = sys.argv[1] if len(sys.argv)>1 else '.'
for k in ['0','0.5','1']:
    im = load(f'{tag}/road-{k}.png')
    sky = im[60:200, 300:700].reshape(-1,3)
    print('crucible', k, 'road/sky lum ratio', round(float(lum(im[road]).mean()/lum(sky).mean()),3))

# puddle interior: box x640-860, y385-460 of road-1 (right puddle), luma std and a smooth-gradient measure
for k in ['0.5','1']:
    im = load(f'{tag}/road-{k}.png')
    p = im[385:460, 650:850].reshape(-1,3)
    s = stats(p); print('puddle box road', k, 'L %.1f chroma %.1f lum %.4f lum std %.4f (%.1f%% of mean)'%(s['L'],s['chroma'],s['lum'],s['lumstd'],100*s['lumstd']/s['lum']))

# slope: sheen on the ramp top (faces the light side) and ground
def region(name, y0,y1,x0,x1):
    out=[]
    for k in ['0','0.5','1']:
        im = load(f'{tag}/slope-{k}.png'); l = lum(im[y0:y1,x0:x1])
        out.append((k, float(l.mean()), float(np.percentile(l,95)), float(l.max())))
    print(name, ' | '.join(f'{k}: mean {m:.4f} p95 {p:.4f} max {x:.4f}' for k,m,p,x in out))
region('slope ramp top', 190,295,570,830)
region('slope ground left', 380,520,20,330)
region('slope ground right (puddle)', 330,520,560,940)

# edge width: per scanline strongest step in 3px-smoothed luma, 10-90 percent width in px
def edge_width(name, x0,y0,w,h):
    res=[]
    for k in ['1','0.5']:
        l = lum(load(f'{tag}/slope-{k}.png'))[y0:y0+h, x0:x0+w]
        k3 = np.ones(3)/3
        widths=[]
        for r in l:
            s = np.convolve(r, k3, 'same')[2:-2]
            g = np.diff(s)
            i = int(np.argmax(np.abs(g)))
            lo,hi = max(0,i-14), min(len(s), i+15)
            seg = s[lo:hi]; a,b = seg.min(), seg.max()
            if b-a < 0.03: continue
            t = (seg-a)/(b-a)
            if g[i] < 0: t = 1-t
            first = np.argmax(t>0.1); last = np.argmax(t>0.9)
            widths.append(abs(last-first))
        res.append((k, len(widths), float(np.median(widths)) if widths else float('nan'), float(np.mean(widths)) if widths else float('nan')))
    print(name, ' | '.join(f'wet {k}: rows {n} median width {m:.1f}px mean {a:.1f}px' for k,n,m,a in res))
edge_width('edge box A x480-600 y230-350', 480,250,80,80)
edge_width('edge box B x810-960 y230-360', 820,240,140,110)
