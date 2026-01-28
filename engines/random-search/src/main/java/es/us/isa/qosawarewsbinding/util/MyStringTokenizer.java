package es.us.isa.qosawarewsbinding.util;

public class MyStringTokenizer {

    int nDelimiters;
    String input;
    String separator;
    char startDelimiter;
    char endDelimiter;
    /** Creates new MyStringTokenizer */
    public MyStringTokenizer(String entrada,String separador,char startDelimiter, char endDelimiter)
    {
        this.input=entrada;
        this.separator=separador;
        nDelimiters=0;
        this.startDelimiter=startDelimiter;
        this.endDelimiter=endDelimiter;
    }
    public MyStringTokenizer(String entrada,String separador) {
        this(entrada,separador,'(',')');                
    }
    
    public String nextToken(String separador)
    {
        this.separator=separador;
        return nextToken();
    }
    public String nextToken()
    {
        String resultado="";
        int indice=input.indexOf(separator);
        if(indice<0){
            resultado=input;
            input="";
            return resultado;
        }
            
        nDelimiters=countDelimiters(input.substring(0,indice)); 
        while(nDelimiters!=0)
        {
            indice=input.indexOf(separator,indice+separator.length());
            nDelimiters=countDelimiters(input.substring(0,indice+separator.length()));
        }
        if(indice<0){
            resultado=input;
            input="";
        }else
        {
            resultado=input.substring(0,indice);
            input=input.substring(indice+separator.length(),input.length());
        }
        return resultado;        
    }
    
    public int countDelimiters(String s)
    {
        int parentesis=0;
        for(int i=0;i<s.length();i++)
            if(s.charAt(i)==startDelimiter)
                parentesis++;
            else if(s.charAt(i)==endDelimiter)
                parentesis--;
        return parentesis;
    }
    
    public boolean hasMoreTokens()
    {
        return !input.equals("");
    }       
}