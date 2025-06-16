import { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';

const prisma = new PrismaClient();

export async function GET() {
    try {
        const repositories = await prisma.repositories.findMany({
            include: {
                organization: true
            },
            orderBy: {
                created_at: 'desc',
            },
        });

        return NextResponse.json(repositories);
    } catch (error) {
        console.error('Error fetching repositories:', error);
        return NextResponse.json(
            { error: 'Failed to fetch repositories' },
            { status: 500 }
        );
    }
} 