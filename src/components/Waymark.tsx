/**
 * The signature element: route numbers rendered as NCN-style waymark patches.
 * National routes (1–2 digits) get the red patch, regional routes (3 digits)
 * the blue — matching the signs on the ground.
 */
export function Waymark({ refNo, size = "md" }: { refNo: string; size?: "sm" | "md" | "lg" }) {
  const regional = refNo.length >= 3;
  return (
    <span
      className={`waymark waymark--${size} ${regional ? "waymark--regional" : ""}`}
      aria-label={`Route ${refNo}`}
    >
      {refNo}
    </span>
  );
}
