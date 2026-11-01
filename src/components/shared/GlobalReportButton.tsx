import React, { useState } from 'react';
import { MessageSquareWarning, X, AlertCircle } from 'lucide-react';
import { db, auth } from '../../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export const GlobalReportButton: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmed = reportText.trim();
    if (!trimmed) return;

    if (trimmed.length > 2000) {
      setErrorMessage('Report is too long (maximum 2,000 characters).');
      return;
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      setErrorMessage('You must be signed in to submit a report.');
      return;
    }

    setStatus('submitting');
    setErrorMessage(null);

    const username = localStorage.getItem('scholar_username') || currentUser.displayName || 'Scholar';
    const context = window.location.pathname;

    try {
      await addDoc(collection(db, 'reports'), {
        text: trimmed.slice(0, 2000),
        username,
        context,
        uid: currentUser.uid,
        createdAt: serverTimestamp(),
        resolved: false,
      });

      setStatus('success');
      setTimeout(() => {
        setIsOpen(false);
        setReportText('');
        setStatus('idle');
        setErrorMessage(null);
      }, 2000);
    } catch (err: any) {
      setStatus('idle');
      const msg = err?.message || err?.code || String(err) || 'Failed to submit report. Please check your connection.';
      setErrorMessage(msg);
    }
  };

  const handleOpen = () => {
    setIsOpen(true);
    setErrorMessage(null);
    setStatus('idle');
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-teal-900 bg-slate-100 hover:bg-teal-50 border border-slate-200 hover:border-teal-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
        title="Report an Issue or Feedback"
      >
        <MessageSquareWarning className="w-3.5 h-3.5 text-teal-700" />
        <span>Feedback / Report</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Report an Issue or Feedback</h3>
              <button
                onClick={() => setIsOpen(false)}
                className="text-slate-500 hover:text-slate-800 cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {status === 'success' ? (
              <div className="text-center py-8 text-emerald-600 font-semibold">
                ✅ Report submitted successfully!
              </div>
            ) : (
              <>
                {!auth.currentUser && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
                    <span>You are not signed in. Please sign in to submit a feedback report.</span>
                  </div>
                )}

                <textarea
                  value={reportText}
                  onChange={(e) => {
                    setReportText(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  maxLength={2000}
                  placeholder="Describe your issue or provide feedback (up to 2,000 characters)..."
                  className="w-full h-32 p-3 border border-slate-300 rounded-lg text-sm focus:border-teal-600 outline-hidden"
                />

                <div className="flex justify-between items-center text-xs text-slate-400">
                  <span>{reportText.trim().length} / 2000</span>
                </div>

                {errorMessage && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
                    <span className="break-words">{errorMessage}</span>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setIsOpen(false)}
                    className="px-4 py-2 text-slate-600 hover:text-slate-900 font-semibold text-sm cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={status === 'submitting' || !reportText.trim() || !auth.currentUser}
                    className="px-4 py-2 bg-teal-800 hover:bg-teal-900 text-white rounded-lg font-semibold text-sm cursor-pointer disabled:opacity-50"
                  >
                    {status === 'submitting' ? 'Submitting...' : 'Submit Report'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};
