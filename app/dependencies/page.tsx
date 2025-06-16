'use client';

import { useEffect, useState } from 'react';

interface Repository {
    id: number;
    name: string;
    full_name: string;
    description: string | null;
    url: string;
    has_package_json: boolean;
    organization: {
        name: string;
    };
}

export default function DependenciesPage() {
    const [repositories, setRepositories] = useState<Repository[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const response = await fetch('/api/dependencies');
                if (!response.ok) {
                    throw new Error('Failed to fetch data');
                }
                const data = await response.json();
                setRepositories(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    if (loading) return <div className="p-4">Loading...</div>;
    if (error) return <div className="p-4 text-red-500">Error: {error}</div>;

    return (
        <div className="container mx-auto p-4">
            <h1 className="text-2xl font-bold mb-4">Repository Dependencies</h1>
            <div className="grid gap-4">
                {repositories.map((repo) => (
                    <div key={repo.id} className="border rounded-lg p-4 shadow-sm">
                        <div className="flex justify-between items-start">
                            <div>
                                <h2 className="text-xl font-semibold">{repo.full_name}</h2>
                                <p className="text-gray-600">Organization: {repo.organization.name}</p>
                                {repo.description && (
                                    <p className="mt-2 text-gray-700">{repo.description}</p>
                                )}
                            </div>
                            <div className="flex items-center">
                                <span className={`px-2 py-1 rounded text-sm ${repo.has_package_json
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-gray-100 text-gray-800'
                                    }`}>
                                    {repo.has_package_json ? 'Has package.json' : 'No package.json'}
                                </span>
                            </div>
                        </div>
                        <div className="mt-4">
                            <a
                                href={repo.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-500 hover:text-blue-700"
                            >
                                View on GitHub →
                            </a>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
} 