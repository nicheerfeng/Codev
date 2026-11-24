import { Button } from "@/components/ui/button";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  title?: string;
  onClose?: () => void;
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/** 隔离子面板渲染异常，避免单个工具模块崩溃导致整个主窗口黑屏。 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PanelErrorBoundary]", this.props.title ?? "panel", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2.5 p-4 text-center text-xs">
        <div className="font-medium text-destructive">
          {this.props.title ? `${this.props.title}加载异常` : "面板加载异常"}
        </div>
        <div className="max-w-md break-words text-[11px] text-muted-foreground">
          {this.state.error.message || "渲染过程中出现未预期错误"}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </Button>
          {this.props.onClose && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={this.props.onClose}
            >
              关闭
            </Button>
          )}
        </div>
      </div>
    );
  }
}
