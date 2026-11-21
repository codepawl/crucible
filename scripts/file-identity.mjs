// Whether a file opened by path is still the file a path stat described.
// Node 22.13.1 on Windows reports path dev 0 while fstat reports the volume serial.
// Treat that missing path device as unknown, but still require a matching inode.
export function sameFile(pathStat, handleStat, platform = process.platform) {
  if (pathStat.ino !== handleStat.ino) return false;
  if (pathStat.dev === handleStat.dev) return true;
  return platform === 'win32' && pathStat.dev === 0;
}
