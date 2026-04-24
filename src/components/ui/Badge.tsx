interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "highlighted";
  className?: string;
}

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  const styles = {
    default: "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20",
    highlighted: "bg-gradient-to-r from-cyan-500/20 to-violet-500/20 text-white border border-white/20",
  };

  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
