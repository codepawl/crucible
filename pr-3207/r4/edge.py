import sys, json
from PIL import Image
import numpy as np
from scipy import ndimage
# Pupil edge radius: angular-median luminance profile around the pupil centre over 8 directions at the pupil's left and upper side (away from the
# highlight), first radius where it passes halfway between the core and the brightest iris ring. Pupil diameter = twice that radius.
centres=json.loads(sys.argv[1])
for path in sys.argv[2:]:
    name=path.split('/')[-1]; cx,cy=centres[name]
    im=np.asarray(Image.open(path).convert('RGB')).astype(float); lum=ndimage.median_filter(im@[0.2126,0.7152,0.0722],size=3)
    h,w=lum.shape; yy,xx=np.mgrid[0:h,0:w]; r=np.hypot(yy-cy,xx-cx); a=np.degrees(np.arctan2(yy-cy,xx-cx))
    sector=(np.abs(a)>135)|((a<-100)&(a>-135))|((a>100)&(a<135))
    prof=np.array([np.median(lum[sector&(r>=k)&(r<k+2)]) for k in range(0,110)])
    prof=ndimage.uniform_filter1d(prof,3)
    peak=prof[20:100].max(); core=prof[2:8].mean(); half=core+0.5*(peak-core)
    edge=int(np.argmax((prof>half)&(np.arange(110)>10)))
    print(f"{name:24s} edge_r={edge:3d}px pupil_d={2*edge:3d}px core={core:5.1f} peak={peak:5.1f}")
