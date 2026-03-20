import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import './app.css';

interface AppProps {
  host: EmbeddableWidgetAPI;
}

export function App({host}: AppProps) {
  return (
    <div className="hello-world-container">
      <h1 className="hello-world-title">Hello World</h1>
    </div>
  );
}
