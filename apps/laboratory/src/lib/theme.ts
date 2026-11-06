import { useEffect, useState } from "react";

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("ifsoul-lab-theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      /* Theme works without storage. */
    }
    return "light";
  });
  useEffect(() => {
    const update = (event: Event) => {
      const value = (event as CustomEvent<"light" | "dark">).detail;
      if (value === "light" || value === "dark") setTheme(value);
    };
    window.addEventListener("ifsoul-theme", update);
    return () => window.removeEventListener("ifsoul-theme", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#191919" : "#ffffff");
    try {
      localStorage.setItem("ifsoul-lab-theme", theme);
    } catch {
      /* Storage is optional. */
    }
    window.dispatchEvent(new CustomEvent("ifsoul-theme", { detail: theme }));
  }, [theme]);
  return {
    theme,
    toggleTheme: () =>
      setTheme((value) => (value === "dark" ? "light" : "dark")),
  };
}
