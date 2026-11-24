import sys
from PIL import Image
import numpy as np
for path in sys.argv[1:]:
    g=np.asarray(Image.open(path).convert('L')).astype(float)
    row=g[270, 380:580]
    dark=np.where(row<45)[0]
    # largest contiguous run
    runs=np.split(dark, np.where(np.diff(dark)!=1)[0]+1)
    run=max(runs,key=len)
    # iris texture contrast ring: mean gradient energy
    print(path, 'pupil width', len(run), 'from', run[0]+380, 'to', run[-1]+380)
