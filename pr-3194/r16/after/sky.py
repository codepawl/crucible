import numpy as np
import compare_helpers as h
from compare_helpers import luminance, to_linear, masks, VIEWS
h.GLAZE='diag2'
view='hero-clouds'
puddle, road, ground = masks(view, VIEWS[view][1])
def enc(l):
    l=np.clip(l,0,1); return np.where(l<=0.0031308,l*12.92,1.055*l**(1/2.4)-0.055)
ref_pt = to_linear(h.pt_image(f'{view}-puddle-black')); g = to_linear(h.glaze_image(f'{view}-reflection'))
lp = ref_pt@[0.2126,0.7152,0.0722]; lg = g@[0.2126,0.7152,0.0722]
for name, sel in [('bright (tracer>0.02)', puddle&(lp>0.02)), ('mid (0.005-0.02)', puddle&(lp>0.005)&(lp<=0.02)), ('dark (<0.005)', puddle&(lp<=0.005))]:
    pm = ref_pt[sel].mean(0); gm = g[sel].mean(0)
    print(name, 'px', int(sel.sum()), 'lum glaze %.4f tracer %.4f ratio %.2f' % (lg[sel].mean(), lp[sel].mean(), lg[sel].mean()/lp[sel].mean()), 'chroma glaze', np.round(gm/gm.mean(),3), 'tracer', np.round(pm/pm.mean(),3))
