export function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect("/login");
    if (!roles.includes(u.role)) return res.status(403).send("No autorizado");
    next();
  };
}

// Cajero can only access assigned campuses
export async function restrictCampus(req, res, next) {
  const u = req.session.user;
  if (!u) return res.redirect("/login");
  if (u.role === "ADMIN") return next();
  const campusId = Number(req.query.campus_id || req.body.campus_id || req.params.campus_id || 0);
  if (!campusId) return next(); // some views don't need campus restriction
  const allowed = (u.campuses || []).includes(campusId);
  if (!allowed) return res.status(403).send("Campus no autorizado");
  next();
}
