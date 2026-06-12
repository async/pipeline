export function healthResponse(now = () => new Date()) {
  return {
    status: "ok",
    checkedAt: now().toISOString()
  };
}
