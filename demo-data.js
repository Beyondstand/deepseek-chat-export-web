/* 演示数据：?demo=1 时载入，便于无登录态预览页面效果（内容与任何真实账号无关）。 */
window.DS_DEMO = {
  sessions: [
    {
      id: "demo-0001",
      title: "论文投稿回复信",
      updated_at: 1763450000,
      model_type: "deepseek_reasoner",
      messages: [
        {
          role: "user",
          inserted_at: 1763440000,
          content: "帮我写一封投稿回复信，审稿人主要质疑样品量太小。",
          thinking: "",
          searches: [],
        },
        {
          role: "assistant",
          inserted_at: 1763440060,
          content: "下面是回复信草稿：\n\n> We thank the reviewer for the careful reading. We agree that the sample size (n=24) is a limitation, and we have added a power analysis in Section 3.2 ...\n\n需要我把它改成更委婉的语气吗？\n\n<script>alert('这段会被转义，不会执行')</script>",
          thinking: "用户需要回复审稿人关于样品量的质疑。要点：承认局限、补充统计功效分析、说明追加实验计划。语气要礼貌而坚定。",
          searches: [
            { query: "reviewer response sample size limitation wording", results: [{ title: "How to respond to reviewers - Nature", url: "https://www.nature.com/example" }] },
          ],
        },
        {
          role: "user",
          inserted_at: 1763445000,
          content: "语气再委婉一点，并补充我们计划追加 30 个样品。",
          thinking: "",
          searches: [],
        },
        {
          role: "assistant",
          inserted_at: 1763445060,
          content: "已改得更委婉，并加入追加实验计划：\n\n> We sincerely appreciate this constructive comment. While the current cohort (n=24) is limited, we are now expanding the dataset with 30 additional samples (see revised Section 3.2 and Figure S3) ...",
          thinking: "",
          searches: [],
        },
      ],
    },
    {
      id: "demo-0002",
      title: "Python 批量重命名脚本",
      updated_at: 1763430000,
      model_type: "deepseek_chat",
      messages: [
        {
          role: "user",
          inserted_at: 1763420000,
          content: "写一个 Python 脚本，把目录里的图片按拍摄日期重命名。",
          thinking: "",
          searches: [],
        },
        {
          role: "assistant",
          inserted_at: 1763420030,
          content: "可以用 Pillow 读 EXIF：\n\n```python\nfrom PIL import Image\nfrom pathlib import Path\n\nfor p in Path('photos').glob('*.jpg'):\n    exif = Image.open(p).getexif()\n    dt = exif.get(306)  # DateTime\n```\n\n需要处理重名冲突时加序号后缀。",
          thinking: "",
          searches: [],
        },
      ],
    },
  ],
};
