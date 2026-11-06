import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "secondary" | "primary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = ["k-btn"];
  if (variant !== "secondary") classes.push(`k-btn-${variant}`);
  if (size !== "md") classes.push(`k-btn-${size}`);
  if (className) classes.push(className);
  return <button type={type} className={classes.join(" ")} {...rest} />;
}
