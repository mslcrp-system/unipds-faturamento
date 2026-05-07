import { cn } from "@/lib/utils";
import { HTMLAttributes } from "react";

type Variant = "default" | "success" | "warning" | "destructive" | "muted";

export function Badge({
  variant = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    default: "bg-primary text-primary-foreground",
    success: "bg-success/10 text-success border border-success/30",
    warning: "bg-warning/10 text-warning border border-warning/30",
    destructive: "bg-destructive/10 text-destructive border border-destructive/30",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", styles[variant], className)}
      {...props}
    />
  );
}
