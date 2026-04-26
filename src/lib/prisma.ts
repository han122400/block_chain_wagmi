import { PrismaClient } from '@prisma/client'

// Next.js 개발 환경에서 HMR(Hot Module Reload) 시 PrismaClient가
// 여러 개 생성되는 문제를 방지하기 위해 global에 캐싱합니다.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
