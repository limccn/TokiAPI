// 公开页 chrome（header / footer）共享的会话态 props。
// 会话在 MarketingLayout 里只查一次，再下发给两个 chrome 组件（design.md §3）。
export interface MarketingChromeProps {
  /** 会话查询已落定（isMounted && !isPending）；false 时 header 渲染等宽占位防跳动。 */
  sessionReady: boolean;
  /** sessionReady && user !== null —— 未就绪时恒 false（fail-closed，按未登录呈现）。 */
  signedIn: boolean;
}
