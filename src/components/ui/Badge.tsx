interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "highlighted";
  className?: string;
}

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  const styles = {
    default: "bg-accent-bg text-accent border border-accent-border",
    highlighted: "bg-gradient-to-r from-orange-400/20 to-yellow-400/20 text-content border border-outline-strong",
  };

  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
