// 公开页外链的唯一真源（design.md §3）：header / footer / 首页 / 文档页都从这里取，
// 避免同一个 URL 在四处各写一遍后漂移。
export const GITHUB_URL = "https://github.com/limccn/TokiAPI";

/** 部署与运维细节的落点 —— 产品文档页不重复 README 的内容。 */
export const GITHUB_README_URL = `${GITHUB_URL}#readme`;
