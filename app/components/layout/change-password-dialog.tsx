// Change password 弹窗（09-17-password-menu-and-dialog-overflow，design §3.1）。
//
// 为什么从 Profile 弹窗里搬出来单独成窗：改密原先是 Profile 弹窗底部的内嵌区块，
// 于是「改密」被藏在「Profile」这个语义之下（用户得先点 Profile 才发现改密在里面）。
// 升为账户菜单的**并列项**后，「打开哪个弹窗」由菜单项直接决定，改密不再要经过 Profile；
// 副作用是 Profile 弹窗显著变矮（原本 642px 高，矮视口下上下各溢 21px 的元凶之一）。
//
// 判据（hasPassword）**不在本组件里**：入口由 user-button.tsx 的 PasswordMenuItem 门控
// （09-21 起该项恒常驻、查询未就绪/失败时置灰；11-06 起 `hasPassword === false` 打开的是
// 并列的 SetPasswordDialog，本弹窗只服务「已有密码」的账号；唯一真源仍是 GET /api/me/profile）；
// 本组件只在被打开时渲染表单 —— 判据只有一个消费方，就不会出现两处各自推导而漂移。
//
// 表单**零改动**：change-password-form.tsx 的逻辑、错误码映射、成功文案一字未动（R5）。
import { ChangePasswordForm } from "@/components/layout/change-password-form";
import { Dialog } from "@/components/ui/dialog";

export interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change password"
      // 事先说明副作用：改密会踢掉其他设备（revokeOtherSessions）。放在描述里而不是只写在
      // 成功文案里 —— 用户在提交前就该知道这一步会做什么。
      description="Your other devices will be signed out."
    >
      {/* 只在打开时挂载内容：关闭态不持有表单 state，每次重开都是干净的空表单
          （与 ProfileDialog 同一写法，见那里的注释） */}
      {open ? <ChangePasswordForm /> : null}
    </Dialog>
  );
}
