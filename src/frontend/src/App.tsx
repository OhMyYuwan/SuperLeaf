import './index.css'

function App() {
  return (
    <div className="w-full h-full bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          YuwanLabWriter
        </h1>
        <p className="text-lg text-gray-600 mb-8">
          本地Web科研写作系统 - 前端初始化完成
        </p>
        <div className="flex gap-4 justify-center">
          <div className="px-6 py-3 bg-blue-500 text-white rounded-lg">
            LaTeX 编辑器
          </div>
          <div className="px-6 py-3 bg-green-500 text-white rounded-lg">
            Agent 评审
          </div>
          <div className="px-6 py-3 bg-purple-500 text-white rounded-lg">
            Workflow 编排
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
