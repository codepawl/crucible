import sys, json
import numpy as np
from PIL import Image
import compare_helpers as h
from compare_helpers import luminance, to_linear, masks, VIEWS, W, H
h.GLAZE = sys.argv[1]
out = sys.argv[2]
view='hero-clouds'
puddle, road, ground = masks(view, VIEWS[view][1])
cols = np.zeros_like(puddle); cols[:, 75:195] = True
region = puddle & cols
def enc(l):
    l=np.clip(l,0,1); return np.where(l<=0.0031308,l*12.92,1.055*l**(1/2.4)-0.055)
tot_pt = to_linear(h.pt_image(f'{view}-puddle-plain')); ref_pt = to_linear(h.pt_image(f'{view}-puddle-black'))
g_tot = h.glaze_image(f'{view}-total'); g_ref = h.glaze_image(f'{view}-reflection')
def stat(img_srgb, mask):
    lin = to_linear(img_srgb)[mask]; m = lin.mean(0); lum = float(m@[0.2126,0.7152,0.0722])
    return dict(lum=round(lum,4), chroma=[round(float(c),3) for c in m/m.mean()], px=int(mask.sum()))
res = {'region_px': int(region.sum()),
 'glaze_total': stat(g_tot, region), 'tracer_total': stat(enc(tot_pt), region),
 'glaze_reflection': stat(g_ref, region), 'tracer_reflection': stat(enc(ref_pt), region)}
# sky half: puddle pixels right of the region
sky = puddle & ~cols; sky[:, :195]=False
res['sky_region']={'glaze_reflection':stat(g_ref,sky),'tracer_reflection':stat(enc(ref_pt),sky),'glaze_total':stat(g_tot,sky),'tracer_total':stat(enc(tot_pt),sky)}
json.dump(res, open(out,'w'), indent=1); print(json.dumps(res))
# 4x crop side by side: columns 75..195, rows spanning puddle in region
rows = np.where(region.any(1))[0]; r0,r1 = rows.min()-4, rows.max()+4
def crop(a): return a[r0:r1, 70:200]
panels = [crop(g_tot), crop(enc(tot_pt)), crop(g_ref), crop(enc(ref_pt))]
sheet = np.concatenate([np.concatenate(panels[:2],1), np.ones((4,panels[0].shape[1]*2,3)), np.concatenate(panels[2:],1)],0)
Image.fromarray((np.clip(sheet,0,1)*255).astype(np.uint8)).resize((sheet.shape[1]*4, sheet.shape[0]*4), Image.NEAREST).save(out.replace('.json','.png'))
