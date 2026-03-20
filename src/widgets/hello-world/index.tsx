import '@jetbrains/ring-ui-built/components/style.css';
import {createRoot} from 'react-dom/client';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import {App} from './app';

const host = await YTApp.register() as EmbeddableWidgetAPI;

const root = createRoot(document.getElementById('root')!);
root.render(<App host={host} />);
