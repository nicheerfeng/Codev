import { PROVIDER_EXAMPLE, MODEL_EXAMPLE } from "./modelDashboard";

/** 展示与当前卡片操作一致的入门步骤和可参考的 JSON 示例。 */
export function PiModelsHelp() {
  return (
    <section
      aria-label="模型看板使用说明"
      className="reader-scrollbar min-h-0 overflow-auto rounded-xl border border-border bg-muted/30 p-4 text-sm leading-7"
    >
      <h3 className="mb-2 font-medium">从添加服务商到开始对话</h3>
      <p>
        1．点击上方“增加”，为接口创建一个服务商（Provider）。在“公共配置”卡片顶部填写便于识别且不重复的名称，例如
        my-provider；同一服务商下的模型共用接口地址、协议和 API Key。
      </p>
      <p>
        2．编辑公共配置：baseUrl 填服务商提供的 API 地址；api
        按其接口文档填写，常见为 openai-completions、openai-responses 或
        anthropic-messages。apiKey
        填你的密钥；已有环境变量或命令引用保持原写法。示例地址与密钥是占位内容，需自行替换。
      </p>
      <pre className="my-2 overflow-auto rounded-lg bg-background p-3 font-mono leading-5">
        {PROVIDER_EXAMPLE}
      </pre>
      <p>
        3．点击“新增模型”，每个模型一张卡片。id
        必须与服务商提供的模型标识完全一致；name
        是你希望显示的名字。同一服务商内的 id
        不能重复。还要添加其他模型时，再点“新增模型”或使用卡片顶部的复制按钮。
      </p>
      <pre className="my-2 overflow-auto rounded-lg bg-background p-3 font-mono leading-5">
        {MODEL_EXAMPLE}
      </pre>
      <p>
        4．需要时再补充 reasoning（是否支持思考）、input（例如 ["text",
        "image"]）、contextWindow（上下文长度）和
        maxTokens（最大输出）。这些值请依据真实模型能力填写，已有
        compat、headers、modelOverrides 等字段会保留。
      </p>
      <p>
        5．点击卡片顶部的保存图标，或在这张卡片中按
        Ctrl+S，仅保存当前卡片到同一份 models.json。公共配置卡片中请勿再写
        models 数组；下方模型卡片会自动组成该数组。
      </p>
      <h3 className="mt-3 font-medium">保存、复制和删除</h3>
      <p>
        卡片顶部的保存按钮只保存这张卡片，其他未保存内容留在草稿中。建议先保存公共配置，再逐张保存模型。新服务商下首次保存模型时会同时建立该服务商的公共配置。服务商更名请保存公共配置卡片。
      </p>
      <p>
        复制模型会生成带 -copy 后缀的新
        id，请按服务商实际标识修改。删除按钮需连续点击两次；移开焦点即取消确认。确认删除立即更新对应的已保存卡片，其他草稿保持；未保存的新卡片直接丢弃。切换服务商不会丢失草稿。
      </p>
      <p>
        每张卡片支持 Ctrl+F
        搜索、代码折叠和文字选择。保存失败时保留草稿；修改后新启动的 Pi
        会话读取新配置，正在运行的会话不会被强制重启。关闭设置后，在输入框旁选择模型即可开始对话。
      </p>
      <h3 className="mt-3 font-medium">单模型与全部测试</h3>
      <p>
        模型卡片上的“测试”检查这个模型，顶部“测试全部”检查所有服务商的已保存模型。测试会实际发送一次“Reply
        only OK.”短请求，显示可用/失败和包含 Pi
        启动时间的总耗时；未保存的草稿不参与测试，请先保存相关卡片。
      </p>
      <p>
        测试最多两路并发，每个模型最多等待 45
        秒；使用临时会话，不写入历史、不调用工具。关闭设置会取消余下测试。测试不会自动运行。
      </p>
    </section>
  );
}
