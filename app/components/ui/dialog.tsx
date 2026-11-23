// 轻量 Modal（无 Radix）：Esc 关闭、遮罩点击关闭、打开时聚焦面板。
// 语义与可访问性：role="dialog" + aria-modal + 标题关联（spec quality.md）。
//
// 为什么必须 portal 到 document.body：`position: sticky` 的祖先**自成层叠上下文**（z-index: auto
// 也一样）。弹窗若渲染在这种祖先内部（例：app-layout 的 sticky <aside> 里的头像菜单弹窗），
// `fixed inset-0 z-50` 只在该上下文内比较；而 <main> 在 DOM 中位于 <aside> 之后，其中任何
// positioned 元素（table.tsx 的 relative 包裹层、Search 图标包裹层）都会绘制在**整个弹窗之上**
// —— 表现为页面内容盖住弹窗、点击被截走。挂到 body 后 z-50 在根层叠上下文参与比较，
// 覆盖一切 z-index < 50 的内容，与弹窗挂在哪个容器里无关。
//
// 矮视口高度兜底（09-17-password-menu-and-dialog-overflow，design §2.4/§2.5）：
// 面板原先无高度上界，高于视口时被 items-center 上下**均匀溢出**（实测 Profile 弹窗 642px
// 在 600px 视口下 rect.top = -21、上下各溢 21px），内容不可达、关闭按钮可能露在视口外。
// 本文件是共享原语（13 处调用），故兜底必须落在原语上而不是逐个调用方。
//
// 为什么是 `max-h-full` 而不是 `max-h-[calc(100vh-2rem)]` / `100dvh`：
//   面板是遮罩层（`fixed inset-0` + `p-4`）的 flex item，百分比 max-height 解析到 flex 容器
//   **内容盒**的高度 = 视口高 − 2rem。两个好处：不引入视口单位（`vh` 在移动端含可隐藏的
//   URL 栏高度，会算大 → 仍然溢出，正是要修的场景），也不必重复 `p-4` 的数值
//   （遮罩 padding 改了自动跟随，不存在「改了 p-4 这里静默失配」）。
//   前提是遮罩层高度确定 —— `fixed inset-0` 保证了这点。
//
// 为什么滚动落在**内容区**而不是整个面板：整面板 overflow-y-auto 会把标题与关闭按钮一起
// 滚走，矮视口下就出现「看得见字样、点不到按钮」的关闭按钮（Esc 与遮罩点击是另外两条路径，
// 但一个可见却点不到的控件本身就是缺陷）。故面板 flex-col，头部与 footer 常驻，只有内容区滚。
// **刻意不加 flex-1**：加了会让内容区在小弹窗里也撑满、把 footer 推到底部，
// 改变现有小弹窗的布局（AC11 会抓到）。
//
// 本变更对 13 处调用方必须**布局中性** —— 实测抓到一处例外并已消除：
// 面板由块容器改为 flex 后，**外边距折叠失效**。WelcomeDialog 只用 footer、内容区为空，
// 旧版下那个空 div 的 `mt-4` 与 footer 的 `mt-6` 折叠成 24px；改成 flex 后不再折叠，
// 变成 16+24=40px，面板凭空高 16px（@1440×900 实测 172 → 188，且 flex 下
// margin collapsing 不适用于 flex item，无法靠 CSS 找回）。故内容区为空时**根本不渲染它**，
// 间隙回到 24px，与新版逐像素一致。AC11 的指纹比对即由此发现（其余弹窗逐节点相同）。
// 内容区为什么能收缩 —— **承重的是 `overflow-y-auto`，不是 `min-h-0`**：
// flex item 的 `min-height: auto` 只在 `overflow: visible` 时才解析为「内容基于的最小尺寸」；
// 一旦元素本身是滚动容器，该自动最小尺寸即为 **0**，收缩自然成立。09-17 三态 A/B 实测
// （Add provider 弹窗 @360×640，内容 546 需装进 480）：
//   min-h-0 + overflow:auto    → clientH 480，可滚   ✅
//   auto    + overflow:auto    → clientH 480，可滚   ✅（min-h-0 在此**冗余**）
//   auto    + overflow:visible → clientH 546，不收缩 ❌（面板仍被 max-h 压住，内容溢出面板）
//   min-h-0 + overflow:visible → clientH 480，可滚   ✅
// 故真正容易写漏的是「把滚动容器放在需要收缩的那个元素上」；`min-h-0` 保留作双保险
// （仅在有人把 overflow 改成 visible 时才承重）。失效现象是「面板被 max-h 压住、高度看起来
// 合格，但内容被裁掉且滚不动」，比没修更像已修 —— AC10 因此必须断言「能滚到底」，
// 不能只断言高度合格。
// 「头部/footer 常驻」是谁在承重 —— **也不是 `shrink-0`**，同样实测证伪（同一弹窗注入
// footer 形状的容器，A/B 只差 `shrink-0`，各在 3 个滚动位置量测 footer 与标题/关闭按钮）：
//   24px  − shrink-0 → footer h 24.0、y 575.0，3/3 位置均命中   ✅
//   24px  + shrink-0 → footer h 24.0、y 575.0，3/3 位置均命中   ✅（逐像素相同）
//   400px − shrink-0 → footer h 400.0、y 199.0                  ✅（高 footer 也不被压扁）
//   400px + shrink-0 → footer h 400.0、y 199.0                  ✅（逐像素相同）
// 原因与内容区同源、方向相反：头部/footer 的 `overflow` 是 visible，自动最小尺寸即内容尺寸，
// flex 收缩到该尺寸即止；面板里只有内容区是滚动容器（自动最小尺寸被归零），是**唯一**能让出
// 空间的一项，全部溢出都由它吸收。故 `shrink-0` 与 `min-h-0` 同性质 —— 让意图在类名上可见，
// 不是承重件。承重件只有两处：面板的 `max-h-full`（定界）与内容区的 `overflow-y-auto`（让位）。
// 附带效应（CSS 规范）：`overflow-y: auto` 会把 `overflow-x` 一并计算为 `auto`。
// 故本原语的内容区**不得**安放依赖「溢出可见」的绝对定位浮层（下拉菜单等）——
// 那些浮层应 portal 到 body（见 dropdown-menu.tsx）。
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // 回调经 ref 转发：调用方常见 inline lambda（每次渲染新引用）。若直接进 useEffect
  // 依赖，任意渲染都触发 effect 重建 → panelRef.focus() 反复抢焦点，用户输入被断（丢输入）。
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChangeRef.current(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // 早退必须在 portal 之前：open=false 时不往 body 里塞任何节点。
  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      {/* 遮罩 = 80% 黑 + backdrop-blur。
          为什么光靠加深不够：alpha 合成只能把底色按比例压暗，压不掉。最亮的前景
          （text-foreground 级 Copy 按钮，rgb(225,231,239)）在 60% 下对比度约 3.15:1
          —— 恰在 WCAG 非文本阈值 3:1 上，明显可读；加到 80% 只降到约 1.55:1，
          数字虽低于一切阈值，**肉眼看仍然读得出来**（09-17 实测截图证据：
          evidence/ac12-users-invite-copy-under-mask.png）。要让亮内容真正"消失"，
          得靠模糊把它从"文字"变成"色块"，而不是继续加黑。
          blur 只作用于遮罩自身所采样的背景；弹窗面板是它的**兄弟节点**（z-10，后绘制），
          不受影响。 */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        className={cn(
          "relative z-10 flex max-h-full w-full max-w-lg flex-col rounded-lg border bg-card p-6 shadow-lg outline-none",
          className,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id="dialog-title" className="text-lg font-semibold leading-none">
              {title}
            </h2>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => onOpenChange(false)}
            aria-label="Close dialog"
          >
            <X />
          </Button>
        </div>
        {/* 内容区：min-h-0 + overflow-y-auto 是矮视口兜底的落点（见文件头）。
            仅在确有 children 时渲染 —— 空的滚动容器在 flex 面板里会连 mt-4 一起占高
            （块容器下它的上下外边距会与 footer 的 mt-6 折叠，flex 下不会），
            会让「只用 footer 的弹窗」（如 WelcomeDialog）凭空高 16px。见文件头末节。 */}
        {children ? (
          <div className="mt-4 min-h-0 overflow-y-auto">{children}</div>
        ) : null}
        {footer ? (
          <div className="mt-6 flex shrink-0 items-center justify-end gap-2">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
