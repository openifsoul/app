export const appOrigin = "http://127.0.0.1:28788";
export const companionOrigin = "http://127.0.0.1:28811";

export function validatedServiceOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {
    // The caller displays an address validation error.
  }
  return null;
}

export function isOrigin(value, origin) {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

export function desktopLoopbackOrigins(environment) {
  function origin(value, fallback) {
    if (value === undefined) return fallback;
    if (
      !/^[1-9]\d{3,4}$/.test(value) ||
      Number(value) < 1024 ||
      Number(value) > 65535
    )
      throw Error("Desktop port must be an integer from 1024 to 65535.");
    return `http://127.0.0.1:${value}`;
  }
  const service = origin(environment.IFSOUL_DESKTOP_APP_PORT, appOrigin);
  const companion = origin(
    environment.IFSOUL_DESKTOP_COMPANION_PORT,
    companionOrigin,
  );
  if (service === companion) throw Error("Choose different Desktop ports.");
  return { appOrigin: service, companionOrigin: companion };
}
