// frontend/src/components/AppShell.jsx
import React from 'react';
import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

const AppShell = ({ children }) => {
  const { sidebarOpen } = useSelector((state) => state.ui);

  return (
    <div className="app-shell-bg flex min-h-screen overflow-x-clip">
      <Sidebar />
      <div
        className={`flex min-h-screen min-w-0 flex-1 flex-col transition-all duration-300 ${
          sidebarOpen ? 'lg:ml-72' : 'lg:ml-24'
        }`}
      >
        <Topbar />
        <main className="flex-1 px-3 pb-6 pt-20 sm:px-5 sm:pt-6 lg:px-8 lg:pt-4">
          <div className="mx-auto w-full max-w-[1600px] min-w-0 overflow-x-clip">{children || <Outlet />}</div>
        </main>
      </div>
    </div>
  );
};

export default AppShell;
