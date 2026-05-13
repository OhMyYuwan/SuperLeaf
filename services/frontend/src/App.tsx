import { AppRouter } from './router'
import { ToastHost } from './features/shared/toast'
import './App.css'

function App() {
  return (
    <>
      <AppRouter />
      <ToastHost />
    </>
  )
}

export default App
