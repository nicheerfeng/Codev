import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** 判断路径是否为可交互预览的 HTML 文件。 */
export function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(path)
}
