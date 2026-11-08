import { t } from '../i18n';
import React from 'react';
import './ErrorBoundary.css';

export default class ErrorBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="error-boundary">
      <div role="alert">
        <h1>{t("界面出现异常")}</h1>
        <p>{t("请重新加载后继续使用。若仍出现此提示，请关闭并重新打开应用。")}</p>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{t("重新加载")}</button>
    </main>;
  }
}
