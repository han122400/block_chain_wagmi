import { PrismaClient } from '@prisma/client'

// Next.js 개발 환경에서 HMR(Hot Module Reload) 시 PrismaClient가
// 여러 개 생성되는 문제를 방지하기 위해 global에 캐싱합니다.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Vercel/타 환경에서 키 이름이 다른 경우를 대비해 안전한 fallback을 제공합니다.
if (!process.env.POSTGRES_PRISMA_URL) {
  process.env.POSTGRES_PRISMA_URL = process.env.DATABASE_URL ?? process.env.POSTGRES_URL
}

if (!process.env.POSTGRES_PRISMA_URL) {
  throw new Error(
    'Missing database URL. Set POSTGRES_PRISMA_URL (or DATABASE_URL / POSTGRES_URL) in environment variables.'
  )
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
