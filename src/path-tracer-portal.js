// Light portals for the CPU path tracer (#1144): the sky is sampled through the windows of a room instead of over the whole map. A portal is a
// resolved rect (path-tracer-scene.js, resolvePortal): `position` is its centre, `normal` points into the room, `across` and `along` span it.
// The sampling density is the one Cook uses: a portal chosen uniformly, a point uniform on it, and a solid-angle pdf summed over every portal
// the direction passes through, so the estimate is unbiased whatever the number of portals.

const PARALLEL_LIMIT = 1e-9;

/**
 * Where the ray from (x, y, z) along `direction` crosses the portal, as distance and cosine against the portal's normal, or null when it misses,
 * runs parallel or starts behind the opening (outside the room). Writes nothing.
 */
function crossPortal(portal, x, y, z, directionX, directionY, directionZ) {
  const facing = directionX * portal.normal[0] + directionY * portal.normal[1] + directionZ * portal.normal[2];
  if (facing > -PARALLEL_LIMIT) return null;
  const toPlane = (portal.position[0] - x) * portal.normal[0] + (portal.position[1] - y) * portal.normal[1] + (portal.position[2] - z) * portal.normal[2];
  if (toPlane >= 0) return null;
  const distance = toPlane / facing;
  const offsetX = x + directionX * distance - portal.position[0];
  const offsetY = y + directionY * distance - portal.position[1];
  const offsetZ = z + directionZ * distance - portal.position[2];
  const across = offsetX * portal.across[0] + offsetY * portal.across[1] + offsetZ * portal.across[2];
  const along = offsetX * portal.along[0] + offsetY * portal.along[1] + offsetZ * portal.along[2];
  if (Math.abs(across) > portal.width / 2 || Math.abs(along) > portal.height / 2) return null;
  return { distance, cosine: -facing };
}

/** The solid-angle density of drawing `direction` from the point through the portals: the sum over the portals it crosses of d^2 / (area cos) / count. 0 when it crosses none. */
export function portalPdf(portals, x, y, z, directionX, directionY, directionZ) {
  if (!portals?.length) return 0;
  let pdf = 0;
  for (const portal of portals) {
    const crossing = crossPortal(portal, x, y, z, directionX, directionY, directionZ);
    if (crossing) pdf += crossing.distance * crossing.distance / (portal.width * portal.height * crossing.cosine);
  }
  return pdf / portals.length;
}

/**
 * Draws a direction from the point through one portal chosen uniformly and returns its pdf (see portalPdf), writing the direction into `out`.
 * Returns 0 and leaves `out` alone when the list is empty or the point is outside the room of the chosen portal.
 */
export function samplePortalDirection(portals, x, y, z, portalUnit, acrossUnit, alongUnit, out) {
  if (!portals?.length) return 0;
  const portal = portals[Math.min(portals.length - 1, Math.floor(portalUnit * portals.length))];
  const across = (acrossUnit - 0.5) * portal.width;
  const along = (alongUnit - 0.5) * portal.height;
  const deltaX = portal.position[0] + portal.across[0] * across + portal.along[0] * along - x;
  const deltaY = portal.position[1] + portal.across[1] * across + portal.along[1] * along - y;
  const deltaZ = portal.position[2] + portal.across[2] * across + portal.along[2] * along - z;
  const length = Math.hypot(deltaX, deltaY, deltaZ);
  if (!(length > 1e-9)) return 0;
  const directionX = deltaX / length;
  const directionY = deltaY / length;
  const directionZ = deltaZ / length;
  const pdf = portalPdf(portals, x, y, z, directionX, directionY, directionZ);
  if (!(pdf > 0)) return 0;
  out[0] = directionX;
  out[1] = directionY;
  out[2] = directionZ;
  return pdf;
}
