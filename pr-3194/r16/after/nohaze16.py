import numpy as np
import compare_helpers as h
from compare_helpers import to_linear, masks, VIEWS
view='hero-clouds'
puddle = masks(view, VIEWS[view][1])[0]
ref_pt = to_linear(h.pt_image(f'{view}-puddle-black')); lp = ref_pt@[0.2126,0.7152,0.0722]
for folder in ('diag2','diag3'):
    h.GLAZE = folder
    g = to_linear(h.glaze_image(f'{view}-reflection')); lg = g@[0.2126,0.7152,0.0722]
    for name, sel in [('bright',puddle&(lp>0.02)),('mid',puddle&(lp>0.005)&(lp<=0.02)),('dark',puddle&(lp<=0.005)),('all',puddle)]:
        gm=g[sel].mean(0); pm=ref_pt[sel].mean(0)
        print(folder, name, 'ratio %.2f'%(lg[sel].mean()/lp[sel].mean()), 'chroma', np.round(gm/gm.mean(),3), 'tracer', np.round(pm/pm.mean(),3))
