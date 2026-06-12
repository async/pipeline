export function renderBanner(user) {
  if (!user || typeof user.name !== "string") {
    throw new Error("renderBanner requires { name: string }.");
  }
  return `Welcome back, ${user.name}.`;
}
