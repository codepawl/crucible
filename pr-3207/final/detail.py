import sys
from PIL import Image
import numpy as np
from scipy import ndimage
# Iris detail: variance of the Laplacian of the luminance, divided by the mean luminance squared (contrast-normalised), in an annulus of the iris.
# sigma is applied to every image first so the tracer's grain (and the raster's pixel steps) are below the band; the tracer is also averaged over 5x5.
def detail(path, centre, sigma, r0, r1, denoise=False):
    lum=np.asarray(Image.open(path).convert('RGB')).astype(float)@[0.2126,0.7152,0.0722]
    if denoise: lum=ndimage.uniform_filter(ndimage.median_filter(lum,size=3),3)
    lum=ndimage.gaussian_filter(lum,sigma)
    lap=ndimage.laplace(lum)
    h,w=lum.shape; yy,xx=np.mgrid[0:h,0:w]; r=np.hypot(yy-centre[1],xx-centre[0])
    m=(r>r0)&(r<r1)
    return lap[m].var()/lum[m].mean()**2
R='../r3/'
for sigma in (1.5,2.5):
  print('sigma',sigma)
  for name,p,c,dn in [('before',R+'before-eye-front.png',(472,274),False),('after',  'final-eye-front.png',(471,274),False),('tracer raw',R+'trace-eye-front.png',(472,274),False),('tracer denoised',R+'trace-eye-front.png',(472,274),True)]:
    print(f'  {name:16s} front {detail(p,c,sigma,55,85,dn):.5f}', end='')
    p2={'before':R+'before-eye-tq.png','after':'final-eye-tq.png'}.get(name,R+'trace-eye-tq.png'); c2=(490,270) if name=='before' else (480,272)
    print(f'   tq {detail(p2,c2,sigma,75,100,dn):.5f}')
