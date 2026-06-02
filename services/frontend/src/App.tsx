import { AppRouter } from './router'
import { AppDocumentTitle } from './features/shared/AppDocumentTitle'
import { ToastHost } from './features/shared/toast'
import './App.css'

function App() {
  return (
    <>
      <AppDocumentTitle />
      <AppRouter />
      <ToastHost />
    </>
  )
}

export default App
