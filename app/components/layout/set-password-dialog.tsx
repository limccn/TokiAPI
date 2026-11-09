// Set password 弹窗（11-06-sms-alicloud-auth，design §7.5）。
//
// 与 ChangePasswordDialog 并列：入口是同一个菜单项，由服务端下发的 hasPassword 决定
// 打开哪一个（见 user-button.tsx 的 PasswordMenuItem）。本弹窗**不**判断「该不该出现」——
// 判据只有一个消费方，就不会出现两处各自推导而漂移。
//
// 描述里刻意点明「之后可用这份密码登录」：这是设置密码的真实用途，用户不该靠猜。
// 不写死「手机号 + 密码」—— 纯 GitHub 号同样能走到本表单，标识可能是邮箱。
// 撤销其他会话的副作用**不**适用于这里（首次设密不构成凭据泄露后的补救），故不写那句提示。
import { SetPasswordForm } from "@/components/layout/set-password-form";
import { Dialog } from "@/components/ui/dialog";

export interface SetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SetPasswordDialog({ open, onOpenChange }: SetPasswordDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Set password"
      description="You'll be able to sign in with your password."
    >
      {/* 只在打开时挂载：关闭态不持有表单 state（与另两个弹窗同一写法） */}
      {open ? <SetPasswordForm /> : null}
    </Dialog>
  );
}
