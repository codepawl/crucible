import sys, json
from PIL import Image
import numpy as np
from scipy import ndimage
# Pupil: connected dark region (highlights filled) found with a fixed luminance threshold to locate it, then re-thresholded halfway between its
# core and the brightest iris rim (so the soft edge of the tracer and the raster compare alike). Iris: area-equivalent diameter of the teal hull.
def analyse(path):
    im=np.asarray(Image.open(path).convert('RGB')).astype(float)
    h,w,_=im.shape
    lum=im@[0.2126,0.7152,0.0722]
    lum_s=ndimage.gaussian_filter(ndimage.median_filter(lum,size=7),1.0)
    yy,xx=np.mgrid[0:h,0:w]
    dark=ndimage.binary_fill_holes(lum_s<45)
    lab,n=ndimage.label(dark)
    areas=ndimage.sum(dark,lab,range(1,n+1))
    cands=[j for j in range(1,n+1) if 1500<areas[j-1]<30000]
    best=min(cands,key=lambda j:np.hypot(*(np.array(ndimage.center_of_mass(lab==j))-[h/2,w/2])))
    py,px=ndimage.center_of_mass(lab==best)
    r=np.hypot(yy-py,xx-px)
    teal=(im[:,:,1]>im[:,:,0]*1.12)&(lum>20)&(r<150)
    teal=ndimage.binary_closing(teal,iterations=3)
    lb,nb=ndimage.label(teal)
    k=int(np.argmax(ndimage.sum(teal,lb,range(1,nb+1))))+1
    iris=ndimage.binary_fill_holes(lb==k)
    irisd=2*np.sqrt(iris.sum()/np.pi)
    core=float(np.median(lum_s[r<8]))
    rim=float(np.percentile(lum_s[(r>irisd*0.22)&(r<irisd*0.5)&iris],90))
    thr=float(__import__("os").environ.get("THR","80"))
    reg=(lum_s<thr)&(r<irisd*0.5)
    l3,_=ndimage.label(reg)
    comp=ndimage.binary_fill_holes(l3==l3[int(round(py)),int(round(px))])
    pd=2*np.sqrt(comp.sum()/np.pi)
    return dict(image=path.split('/')[-1],iris_d=round(irisd,1),pupil_d=round(pd,1),pupil_over_iris=round(pd/irisd,3),pupil_mean_lum=round(float(lum[comp].mean()),1),core_lum=round(core,1),centre=[round(px),round(py)])
rows=[analyse(p) for p in sys.argv[1:]]
for row in rows: print(json.dumps(row))
json.dump(rows,open(sys.argv[0].replace('measure.py','measure-last.json'),'w'),indent=1)
