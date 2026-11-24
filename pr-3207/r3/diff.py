import sys
from PIL import Image, ImageChops
import numpy as np
a=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(float)
b=np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(float)
d=np.abs(a-b)
print('rmse',np.sqrt(((a-b)**2).mean()),'max',d.max(),'pixels>8:',(d.max(axis=2)>8).sum())
