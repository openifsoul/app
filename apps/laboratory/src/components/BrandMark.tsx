/** Decorative brand mark; the surrounding wordmark supplies the accessible name. */
export function BrandMark({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`brand-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 96 80"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <use href="/brand/ifsoul-mark.svg#ifsoul-mark" />
    </svg>
  );
}
