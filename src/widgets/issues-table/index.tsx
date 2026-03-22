import React from 'react';
import ReactDOM from 'react-dom/client';
import '@jetbrains/ring-ui-built/components/style.css';
import {ControlsHeight, ControlsHeightContext} from '@jetbrains/ring-ui-built/components/global/controls-height';
import type {EmbeddableWidgetAPI} from '../../../@types/globals';
import {App} from './app';

const host = await YTApp.register({
  onConfigure: () => {
    // Will be handled by the App component via state
    window.dispatchEvent(new CustomEvent('yt-widget-configure'));
  }
}) as EmbeddableWidgetAPI;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ControlsHeightContext.Provider value={ControlsHeight.S}>
      <App host={host} />
    </ControlsHeightContext.Provider>
  </React.StrictMode>
);
