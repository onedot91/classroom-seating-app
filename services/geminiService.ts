
import { GoogleGenAI } from "@google/genai";

// Initialize Gemini API client using the environment variable directly.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const getTeacherAdvice = async () => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: "초등학교 교실에서 자리를 바꾼 학생들에게 해줄 수 있는 짧고 따뜻하며 재미있는 격려의 메시지 한 문장을 한국어로 생성해줘. (예: '새로운 짝궁과 함께 반짝이는 추억을 만들어봐!')",
    });
    // response.text is a property, not a method.
    return response.text || "새로운 자리에서 즐거운 공부 시간 되세요! 😊";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "새로운 자리에서 친구와 사이좋게 지내요!";
  }
};
