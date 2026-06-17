import { createBrowserRouter, RouterProvider } from 'react-router'
import { Render } from './views/Render'

const router = createBrowserRouter([
  {
    path: '/render',
    Component: Render,
  },
])

export function App() {
  return <RouterProvider router={router} />
}
