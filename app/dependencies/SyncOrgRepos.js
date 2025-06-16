// components/SyncOrgRepos.js
import React, { useState } from 'react';

function SyncOrgRepos() {
  const [organization, setOrganization] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage('');
    setLoading(true);

    try {
      const response = await fetch('/api/sync-organization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ organizationName: organization }),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage(`Success: ${data.message} - Details: ${JSON.stringify(data.details, null, 2)}`);
      } else {
        setMessage(`Error: ${data.message || 'Unknown error'} - ${data.error || ''}`);
      }
    } catch (error) {
      console.error('Error initiating sync:', error);
      setMessage(`Failed to initiate sync: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Sync Organization Repositories</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="GitHub Organization Name"
          value={organization}
          onChange={(e) => setOrganization(e.target.value)}
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Syncing...' : 'Start Sync'}
        </button>
      </form>
      {message && <pre>{message}</pre>}
    </div>
  );
}

export default SyncOrgRepos;
