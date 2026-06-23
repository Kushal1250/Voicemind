import React from 'react';
import { Link } from 'react-router-dom';
import { Mic, Activity, MessageSquare, Shield, ArrowRight } from 'lucide-react';

const Landing = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-slate-950 dark:to-slate-900">
      {/* Navbar */}
      <nav className="border-b border-gray-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center">
                <Mic className="w-6 h-6 text-white" />
              </div>
              <span className="text-xl font-bold text-gray-900 dark:text-white">VoiceMind</span>
            </div>
            <div className="flex items-center gap-4">
              <Link to="/login" className="text-gray-600 dark:text-gray-400 hover:text-gray-900">Sign in</Link>
              <Link to="/signup" className="btn-primary">Get Started</Link>
            </div>
          </div>
        </div>
      </nav>
      
      {/* Hero */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl font-bold text-gray-900 dark:text-white mb-6">
            Intelligent Meeting Recording & Analysis
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Record meetings with ESP32 hardware, transcribe with AI, and get instant insights. 
            All in real-time.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link to="/signup" className="btn-primary text-lg px-8 py-3">
              Start Free
            </Link>
            <Link to="/login" className="btn-secondary text-lg px-8 py-3">
              Live Demo
            </Link>
          </div>
        </div>
      </section>
      
      {/* Features */}
      <section className="py-20 px-4 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-gray-900 dark:text-white mb-12">
            Everything you need for smart meetings
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="p-6 rounded-2xl bg-gray-50 dark:bg-slate-800">
              <div className="w-12 h-12 bg-primary-100 dark:bg-primary-900/30 rounded-xl flex items-center justify-center mb-4">
                <Mic className="w-6 h-6 text-primary-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Hardware Recording</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Use ESP32 with I2S microphone for high-quality audio capture. 20-second chunks uploaded in real-time.
              </p>
            </div>
            <div className="p-6 rounded-2xl bg-gray-50 dark:bg-slate-800">
              <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center mb-4">
                <Activity className="w-6 h-6 text-blue-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Live Monitoring</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Watch recordings happen in real-time. SSE with automatic polling fallback ensures you never miss an update.
              </p>
            </div>
            <div className="p-6 rounded-2xl bg-gray-50 dark:bg-slate-800">
              <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-xl flex items-center justify-center mb-4">
                <MessageSquare className="w-6 h-6 text-purple-600" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">AI Q&A</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Ask questions about your meetings using local LLM. No data leaves your infrastructure.
              </p>
            </div>
          </div>
        </div>
      </section>
      
      {/* Footer */}
      <footer className="py-8 px-4 border-t border-gray-200 dark:border-slate-800">
        <div className="max-w-6xl mx-auto text-center text-gray-500">
          <p>© 2026 VoiceMind. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
